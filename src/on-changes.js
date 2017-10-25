'use strict'

const PouchDB = require('pouchdb')
PouchDB.plugin(require('pouchdb-adapter-memory'))
const events = require('events')
const utils = require('./utils')
const sporks = require('sporks')
const log = require('./log')

// Note: during the benchmark tests, it was determined that it is 10 times faster to iterate through
// 2 docs in a simple array than via the PouchDB memory adapter. Therefore, we will use PouchDB to
// sync the data, but will store the docs in a simple array as we want our UpdateListener to be able
// to iterate through all OnChanges as fast as possible

class OnChanges extends events.EventEmitter {
  constructor (spiegel) {
    super()

    this._spiegel = spiegel
    this._slouch = spiegel._slouch

    this._db = new PouchDB(this._spiegel._namespace + 'on_changes', { adapter: 'memory' })

    this._docs = {}

    // A promise that resolves once the PouchDB data has loaded
    this._loaded = sporks.once(this, 'load')
  }

  _createOnChangesView () {
    var doc = {
      _id: '_design/on_changes',
      views: {
        on_changes: {
          map: [
            'function(doc) {',
            'if (doc.type === "on_change") {',
            'emit(doc._id, null);',
            '}',
            '}'
          ].join(' ')
        }
      }
    }

    return this._slouch.doc.createOrUpdate(this._spiegel._dbName, doc)
  }

  _createViews () {
    return this._createOnChangesView()
  }

  _destroyViews () {
    return this._slouch.doc.getAndDestroy(this._spiegel._dbName, '_design/on_changes')
  }

  create () {
    return this._createViews()
  }

  destroy () {
    return this._destroyViews()
  }

  _setDoc (doc) {
    if (doc._deleted) {
      delete this._docs[doc._id]
    } else {
      this._docs[doc._id] = doc
    }
  }

  async _loadAllDocs () {
    let docs = await this._db.allDocs({ include_docs: true })
    docs.rows.forEach(doc => {
      this._setDoc(doc.doc)
    })
  }

  async _onPaused () {
    await this._loadAllDocs()

    // Alert that the data has been loaded and is ready to be used
    this.emit('load')
  }

  _setDocs (docs) {
    docs.forEach(doc => {
      this._setDoc(doc)
    })
  }

  start () {
    this._from = this._db.replicate
      .from(utils.couchDBURL() + '/' + this._spiegel._dbName, {
        live: true,
        retry: true,
        filter: '_view',
        view: 'on_changes'
      })
      .once('paused', () => {
        this._onPaused()
      })
      .on('error', err => {
        log.error(err)
      })
      .on('change', change => {
        this._setDocs(change.docs)
        this.emit('change')
      })

    return this._loaded
  }

  stop () {
    let completed = sporks.once(this._from, 'complete')
    this._from.cancel()
    return completed
  }

  async all () {
    // all() is a promise so that we have the freedom to change up the storage mechanism in the
    // future, e.g. our future storage mechanism may require IO
    await this._loaded
    return this._docs
  }

  async matchWithDBNames (dbNames) {
    // TODO: if we want to speed up this function even more, we can instead build a single reg ex,
    // e.g. /(on-change-reg-ex-1)|(on-change-reg-ex-1)|(...)/ and do a single comparison. This most
    // likely will have little impact on the performance of the UpdateListener however as the main
    // bottleneck will probably be in the UpdateListener communicating with CouchDB, i.e. dirtying
    // replicators and change liseteners.

    let docs = await this.all()

    let matchingDBNames = {}

    sporks.each(docs, doc => {
      let re = new RegExp(doc.reg_ex)
      dbNames.forEach(dbName => {
        // Does the name match the regular expression?
        if (re.test(dbName)) {
          // Index by name to prevent duplicates
          matchingDBNames[dbName] = true
        }
      })
    })

    return sporks.keys(matchingDBNames)
  }
}

module.exports = OnChanges