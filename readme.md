# usage
(TODO)

## example
```typescript
import ProgrammableDownloader from 'programmable-downloader'

const downloader = new ProgrammableDownloader({
  pages: [                                                                      // Each page is processed by matched extractors
    'https://example.com/gallery',
  ],
  extractors: [
    {
      description:            'gallery view page',
      isMatched:              (url, $) => $('h2').text()?.trim() === 'gallery', // The extractor is used only if this returns true
   // fileSelector:           'section.gallery img,                             // 'href' or 'src' is downloaded
      pageSelector:           [                                                 // 'href' is pushed to 'pages'
        'section.gallery > div.container > a',            // detail page
        'section.gallery + ul.pagination > li.next > a',  // next page
      ].join(','),
      metadataSelectors:      {                                                 // Inner text is extracted as metadata. The value can be used for dirname and all metadata is saved to JSON file.
        'gallery-title': 'h3',
      },
    }
    {
      description:            'image details page',
      isMatched:              (url, $) => url.includes(/images/),
      fileSelector:           'div.media > picture > img,
   // pageSelector:           '',
      metadataSelectors:      {
        'name': 'div.media > .name',
      },
    }
  ],
  options: {
    saveDir: {
      subDirs: ['{{gallery-title}}', '{{name}}'],                               // {{ }} is replaced with metadata
    },
    file: {
      nameLevel: 2,                                                             // The value of "url.split('/').slice(-nameLevel).join('_')" is used as filename
    }
  }
})

downloader.run({dryrun: false})
```
