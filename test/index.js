'use strict'

const chai = require('chai')
chai.use(require('chai-as-promised'))
chai.should()

const testUtils = require('./utils')

describe('spiegel', function () {
  // Extend the timeout as the DB needs more time to process changes
  this.timeout(testUtils.TIMEOUT)

  before(() => {
    return testUtils.spiegel.create()
  })

  after(() => {
    return testUtils.spiegel.destroy()
  })

  require('./spec')
})
