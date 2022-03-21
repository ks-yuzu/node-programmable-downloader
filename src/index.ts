import Axios from 'axios'
import axiosRetry from 'axios-retry'
import cheerio, {CheerioAPI} from 'cheerio'
import iconv from 'iconv-lite'
import chardet from 'chardet'
import log4js from 'log4js'
import deepmerge from 'deepmerge'
import fs from 'fs'
import {URL} from 'url'
import path from 'path'
import _ from 'underscore'

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
  fileUrlModifier:     (url: string) => string
  metadataSelectors:   {[key: string]: string | {[key: string]: string}},
  metadataModifiler:   (key: string, value: string | string[] | {[key: string]: string}) => string | string[] | {[key: string]: string},
  additionalExtractor: (url: string, $: CheerioAPI) => {files?: string[], pages?: string[]}
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
};

export default class ProgrammableDownloader {
  private readonly pages:          {url: string; metadata?: any}[]
  private readonly processedPages: {[key: string]: boolean}
  private readonly extractors:     Partial<Extractor>[]
  private readonly options:        Options

  private readonly axios
  private          dryrun = false // TODO: pass as arguments


  constructor(params: ProgrammableDownloaderParams) {
    this.pages          = params.pages.map(i => ({url: i}))
    this.processedPages = {}
    this.extractors     = params.extractors
    this.options        = deepmerge(defaultOptions, params.options as object, {arrayMerge: (dst, src, op) => src})

    this.axios = Axios.create({
      responseType: 'arraybuffer',
      transformResponse: (d) => iconv.decode(d, chardet.detect(d)?.toString() || 'UTF-8'),
    })
    axiosRetry(this.axios, {retries: 10000})
  }


  public async run(options?: {dryrun: boolean}) {
    if (options?.dryrun) { this.dryrun = options.dryrun }

    while (this.pages.length > 0) {
      await this._processPage()
    }
  }


  private async _processPage() {
    const urlEntry = this.pages.shift()
    if (urlEntry == null) { throw new Error('URL Entry is null') }

    const {url} = urlEntry
    let metadata = urlEntry.metadata || {}
    logger.debug({url, metadata})

    if ( this.processedPages[url] ) {
      logger.debug(`URL '${url}' is processed. Skip.`)
      return
    }
    this.processedPages[url] = true

    const $ = cheerio.load((await this.axios.get(url)).data)

    for (const extractor of this.extractors) {
      if ( extractor.isMatched != null && !extractor.isMatched(url, $) ) { continue }
      if ( extractor.description != null ) {
        logger.debug(`Match extractor: ${extractor.description}`)
      }

      metadata = Object.assign({}, metadata, this._getMetadata($, extractor))

      const fileUrls = this._getFileUrls($, extractor, url)
      logger.debug({'extracted file URLs': fileUrls})
      await this._saveFiles(fileUrls, metadata)

      const pageUrls = this._getPageUrls($, extractor, url)
      logger.debug({'extracted page URLs': pageUrls})
      this.pages.push(...pageUrls.map(url => ({url, metadata})))
    }
  }


  private _getMetadata(
    $: CheerioAPI,
    extractor: Partial<Extractor>
  ) {
    const metadata = Object
      .entries(extractor.metadataSelectors || {})
      .reduce((acc, [fieldName, selector]) => {
        switch (typeof selector) {
          case  'string': {
            const values = $(selector).toArray().map(i => $(i).text().trim())
            acc[fieldName] = values.length === 1 ? values.shift()! : values

            if (extractor.metadataModifiler != null) {
              acc[fieldName] = extractor.metadataModifiler(fieldName, acc[fieldName])
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

            if (extractor.metadataModifiler != null) {
              acc[fieldName] = extractor.metadataModifiler(fieldName, acc[fieldName])
            }
            break
          }
        }
        return acc
      }, {} as {[key: string]: string | string[] | {[key: string]: string}})

    return metadata
  }


  private _getFileUrls($: CheerioAPI, extractor: Partial<Extractor>, currentUrl: string) {
    const urls = $(extractor.fileSelector)
      .toArray()
      .map(i => $(i).attr('href') || $(i).attr('src'))
      .filter(i => i != null)
      .map(src => new URL(src!, currentUrl).href)
      .flatMap(i => extractor.fileUrlModifier == null ? i : extractor.fileUrlModifier(i))

    if (extractor.additionalExtractor) {
      const {files: additionalUrls} = extractor.additionalExtractor(currentUrl, $)
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

    if (extractor.additionalExtractor) {
      const {pages: additionalUrls} = extractor.additionalExtractor(currentUrl, $)
      if (additionalUrls != null) {
        urls.push(...additionalUrls.map(href => new URL(href, currentUrl).href))
      }
    }

    return urls
  }


  private _getSaveDir(metadata: {[key: string]: any}) {
    const subDirs = this.options.saveDir.subDirs.map(dirname => _.template(dirname)(metadata).replace(/[/%*:|"<>]/g, '-'))
    const saveDir = path.join(this.options.saveDir.root, ...subDirs)
    fs.mkdirSync(saveDir, {recursive: true})

    return saveDir
  }


  private _getFilename(fileUrl: string) {
    const domainAndPath = fileUrl.replace(/^https?:\/\//, '').replace(/\?.*$/, '')

    const nSlices = this.options.file.nameLevel
    const filename = domainAndPath.split('/').slice(-nSlices).join('_')
    if ( !filename ) {
      throw new Error('failed to generate filename')
    }

    return filename
  }


  private async _saveFiles(fileUrls: string[], metadata: {[key: string]: any}) {
    const saveDir = this._getSaveDir(metadata)
    logger.debug({saveDir})
    fs.writeFileSync(path.join(saveDir, 'info.json'), JSON.stringify(metadata))

    for (const fileUrl of fileUrls) {
      const filename = this._getFilename(fileUrl)
      const filepath = path.join(saveDir, filename)

      if (this.dryrun) {
        logger.info(`dryrun: download "${fileUrl}" to "${filepath}"`)
        continue
      }

      try {
        const {data: fileData} = await this.axios.get(encodeURI(fileUrl), {transformResponse: d => d})
        if ( fileData.byteLength < this.options.file.minSize ) {
          logger.warn(`this file is less than ${this.options.file.minSize} byte. skip: ${fileUrl}`)
        }
        else if ( this.options.file.overwrite !== true && fs.existsSync(filepath) ) {
          logger.info(`this file is already downloaded. skip: ${fileUrl}`)
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
}
