import Axios, {AxiosInstance} from 'axios'
import axiosRetry             from 'axios-retry'
import cheerio, {CheerioAPI}  from 'cheerio'
import iconv                  from 'iconv-lite'
import chardet                from 'chardet'
import log4js                 from 'log4js'
import deepmerge              from 'deepmerge'
import fs                     from 'fs'
import {URL}                  from 'url'
import path                   from 'path'
import _                      from 'underscore'

const logger = log4js.getLogger()
logger.level = 'debug'

_.templateSettings = {
  interpolate: /\{\{(.+?)\}\}/g
}


type RecursivePartial<T> = {
  [P in keyof T]?: RecursivePartial<T[P]>
};

interface Extractor {
  description:         string
  isMatched:           (url: string, $: CheerioAPI) => boolean
  pageSelector:        string
  fileSelector:        string
  fileUrlModifier:     (fileUrl: string, currentPageUrl: string) => string[]
  metadataSelectors:   {[key: string]: string | {[key: string]: string}},
  metadataModifier:    (key: string, value: string | string[] | {[key: string]: string}) => string | string[] | {[key: string]: string},
  additionalExtractor: {
    file?: (url: string, $: CheerioAPI) => string[],
    page?: (url: string, $: CheerioAPI) => string[],
    metadata?: (url: string, $: CheerioAPI) => {[key: string]: string | string[] | {[key: string]: string}},
  }
  options:             RecursivePartial<Options>
}

interface Options {
  saveDir: {
    root:      string   // default: './download'
    subDirs:   string[] // default: [] (same as "saveRootDir")
  }
  file: {
    nameLevel: number   // default: 1 (0 -> all)
    overwrite: boolean  // default: false
    minSize:   number   // default: 0
  }
}
const defaultOptions: Options = {
  saveDir: {
    root:      './download',
    subDirs:   [],
  },
  file: {
    nameLevel: 1,
    overwrite: false,
    minSize:   0,
  },
}

interface ProgrammableDownloaderParams {
  pages:      string[]
  extractors: Partial<Extractor>[]
  options?:   RecursivePartial<Options>
  axios?:     AxiosInstance
};

export default class ProgrammableDownloader {
  private readonly pages:          {url: string; metadata?: any}[]
  private readonly processedPages: {[key: string]: boolean}
  private readonly extractors:     Partial<Extractor>[]
  private readonly options:        Options

  private readonly axios
  private          dryrun = false // TODO: pass as arguments

  private          currentExtractor?: Partial<Extractor>


  constructor(params: ProgrammableDownloaderParams) {
    this.pages          = params.pages.map(i => ({url: i}))
    this.processedPages = {}
    this.extractors     = params.extractors
    this.options        = deepmerge(defaultOptions, params.options as object, {arrayMerge: (dst, src, op) => src})

    this.axios = params.axios || Axios.create()
    this.axios.defaults.responseType = 'arraybuffer'
    this.axios.defaults.transformResponse = (d) => iconv.decode(d, chardet.detect(d)?.toString() || 'UTF-7')
    axiosRetry(this.axios, {retries: 10000})
  }


  public async run(options?: {dryrun: boolean}) {
    if (options?.dryrun) { this.dryrun = options.dryrun }

    while (this.pages.length > 0) {
      await this._processPage().catch(e => console.error(e))
    }
  }


  private async _processPage() {
    const urlEntry = this.pages.shift()
    if (urlEntry == null) { throw new Error('URL Entry is null') }

    const {url} = urlEntry
    let metadata = urlEntry.metadata || {}
    metadata.url = url
    logger.debug({url, metadata})

    if ( this.processedPages[url] ) {
      logger.debug(`URL '${url}' is processed. Skip.`)
      return
    }
    this.processedPages[url] = true

    const $ = cheerio.load((await this.axios.get(url)).data)

    let foundExtractor = false
    for (const extractor of this.extractors) {
      this.currentExtractor = extractor

      if ( extractor.isMatched != null && !extractor.isMatched(url, $) ) { continue }
      foundExtractor = true

      if ( extractor.description != null ) {
        logger.debug(`Match extractor: ${extractor.description}`)
      }

      metadata = Object.assign({}, metadata, this._getMetadata($, extractor, url))

      const fileUrls = this._getFileUrls($, extractor, url)
      logger.debug({'extracted file URLs': fileUrls})
      await this._saveFiles(fileUrls, metadata)

      const pageUrls = this._getPageUrls($, extractor, url)
      logger.debug({'extracted page URLs': pageUrls})
      this.pages.push(...pageUrls.map(url => ({url, metadata})))
    }

    if (!foundExtractor) {
      logger.warn('match no exctactor')
    }
  }


  private _getMetadata($: CheerioAPI, extractor: Partial<Extractor>, currentUrl: string) {
    const metadata = Object
      .entries(extractor.metadataSelectors || {})
      .reduce((acc, [fieldName, selector]) => {
        switch (typeof selector) {
          case  'string': {
            const values = $(selector).toArray().map(i => $(i).text().trim())
            acc[fieldName] = values.length === 1 ? values.shift()! : values

            if (extractor.metadataModifier != null) {
              acc[fieldName] = extractor.metadataModifier(fieldName, acc[fieldName])
            }
            break
          }
          case 'object': {
            const kv = {} as {[key: string]: string}
            for (const entry of $(selector.entry).toArray()) {
              const key = $(entry).find(selector.key).text().trim()
              const value = $(entry).find(selector.value).text().trim()

              if ( !key && !value ) { continue }
              kv[key] = value
            }
            acc[fieldName] = kv

            if (extractor.metadataModifier != null) {
              acc[fieldName] = extractor.metadataModifier(fieldName, acc[fieldName])
            }
            break
          }
        }
        return acc
      }, {} as {[key: string]: string | string[] | {[key: string]: string}})

    if (extractor.additionalExtractor?.metadata) {
      const additionalMetadata = extractor.additionalExtractor.metadata(currentUrl, $)
      if (additionalMetadata != null) {
        Object.assign(metadata, additionalMetadata)
      }
    }

    return metadata
  }


  private _getFileUrls($: CheerioAPI, extractor: Partial<Extractor>, currentUrl: string) {
    const urls = $(extractor.fileSelector)
      .toArray()
      .map(i => [$(i).attr('href'), $(i).attr('src'), $(i).attr('data-src')])
      .flat()
      .filter(i => i != null)
      .filter(i => ! i!.startsWith('data:'))
      .map(src => new URL(src!, currentUrl).href)
      .flatMap(i => extractor.fileUrlModifier == null ? i : extractor.fileUrlModifier(i, currentUrl))

    if (extractor.additionalExtractor?.file) {
      const additionalUrls = extractor.additionalExtractor.file(currentUrl, $)
      if (additionalUrls != null) {
        urls.push(...additionalUrls.map(href => new URL(href!, currentUrl).href))
      }
    }

    return urls
  }


  private _getPageUrls($: CheerioAPI, extractor: Partial<Extractor>, currentUrl: string) {
    const urls = $(extractor.pageSelector)
      .toArray()
      .map(i => $(i).attr('href'))
      .filter(i => i != null)
      .map(href => new URL(href!, currentUrl).href)

    if (extractor.additionalExtractor?.page) {
      const additionalUrls = extractor.additionalExtractor.page(currentUrl, $)
      if (additionalUrls != null) {
        urls.push(...additionalUrls.map(href => new URL(href, currentUrl).href))
      }
    }

    return urls
  }


  private _getSaveDir(metadata: {[key: string]: any}) {
    const root = this.getOption(['saveDir', 'root'])
    const subDirs = this
      .getOption(['saveDir', 'subDirs'])!
      .map((dirname: string) => _.template(dirname)(metadata).replace(/[/%*:|"<>]/g, '-'))
    const saveDir = path.join(root, ...subDirs)
    fs.mkdirSync(saveDir, {recursive: true})

    return saveDir
  }


  private _getFilename(fileUrl: string) {
    const domainAndPath = fileUrl.replace(/^https?:\/\//, '').replace(/\?.*$/, '')

    const nSlices = this.getOption(['file', 'nameLevel'])
    const filename = domainAndPath.split('/').slice(-nSlices).join('_')
    if ( !filename ) {
      throw new Error('failed to generate filename')
    }

    return filename
  }


  private async _saveFiles(fileUrls: string[], metadata: {[key: string]: any}) {
    const saveDir = this._getSaveDir(metadata)
    logger.debug({saveDir})
    logger.debug({metadata: JSON.stringify(metadata, null, 2)})
    fs.writeFileSync(path.join(saveDir, 'info.json'), JSON.stringify(metadata))

    for (const _fileUrl of fileUrls) {
      const fileUrl  = decodeURI(_fileUrl)
      const filename = this._getFilename(fileUrl)
      const filepath = path.join(saveDir, filename)

      if (this.getOption(['file', 'overwrite']) !== true && fs.existsSync(filepath)) {
        logger.info(`this file is already downloaded. skip: ${fileUrl}`)
        continue
      }

      if (this.dryrun) {
        logger.info(`dryrun: download "${fileUrl}" to "${filepath}"`)
        continue
      }

      try {
        const {data: fileData} = await this.axios.get(encodeURI(fileUrl), {transformResponse: d => d})
        const minFileSize = this.getOption(['file', 'minSize'])
        if ( fileData.byteLength < minFileSize ) {
          logger.warn(`this file is less than ${minFileSize} byte. skip: ${fileUrl}`)
        }
        else {
          fs.writeFileSync(filepath, Buffer.from(fileData), 'binary')
        }
      }
      catch(e) {
        logger.error(`failed to save file: ${fileUrl}`)
        logger.error(e)
      }
    }
  }

  private getOption(path: string[]) {
    const dig = ((obj: {[key: string]: any} | null, keys: string[]) => {
      if (path == null) { return null }

      let p = obj
      for (const key of keys) {
        if (p == null) { return undefined }

        // if (typeof key === 'function') { p = key(p) }
        // else
        { p = p[key] }
      }
      return p as any
    })

    return dig(this.currentExtractor?.options ?? null, path)
        ?? dig(this.options, path)
  }
}
