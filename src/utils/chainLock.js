const debug = require('debug')('liquality:agent:chain-lock')

const EventEmitter = require('events')
const _ = require('lodash')
const cryptoassets = require('@liquality/cryptoassets').default

const { RescheduleError, PossibleTimelockError } = require('./errors')

let counter = 0
const PENDING = {}
const CHAIN_LOCK_TIMESTAMP = {}
const CHAIN_LOCK = {}
const emitter = new EventEmitter()
emitter.setMaxListeners(20)

const wait = millis => new Promise(resolve => setTimeout(() => resolve(), millis))
const waitForRandom = (min, max) => wait(_.random(min, max))

const isERC20 = asset => {
  return cryptoassets[asset].type === 'erc20'
}

const getChainFromAsset = asset => {
  if (isERC20(asset)) return 'ETH'

  return asset
}

const attemptToLockChain = asset => {
  const chain = getChainFromAsset(asset)

  if (CHAIN_LOCK[chain]) {
    return {
      chain,
      success: false
    }
  }

  CHAIN_LOCK[chain] = true

  return {
    chain,
    success: true
  }
}

const unlockAsset = chain => {
  CHAIN_LOCK[chain] = false

  emitter.emit(`unlock:${chain}`)
}

const getLockForAsset = async (asset, id) => {
  const { chain, success } = attemptToLockChain(asset)

  if (!PENDING[chain]) PENDING[chain] = new Set()

  if (!success) {
    if (!PENDING[chain].has(id)) {
      PENDING[chain].add(id)
      debug(`${PENDING[chain].size} actions pending for ${chain} [#${id}]`)
    }

    await new Promise(resolve => emitter.once(`unlock:${chain}`, () => resolve()))

    return getLockForAsset(asset, id)
  }

  PENDING[chain].delete(id)

  const previousTimestamp = CHAIN_LOCK_TIMESTAMP[chain]

  if (previousTimestamp) {
    const now = Date.now()
    const sincePreviousLock = now - previousTimestamp
    const minGap = _.random(3500, 7000)
    const diff = minGap - sincePreviousLock

    if (diff >= 0) {
      debug(`Waiting for ${diff}ms before unlocking ${chain} [#${id}]`)
      await wait(diff)
    }
  }

  debug(`Got lock for ${chain} [#${id}] - (Pending: ${[...PENDING[chain]]})`)

  CHAIN_LOCK_TIMESTAMP[chain] = Date.now()

  return chain
}

const withLock = async (asset, func) => {
  const id = ++counter
  const chain = await getLockForAsset(asset, id)

  try {
    const result = await func()
    return result
  } catch (e) {
    if (['PendingTxError', 'BlockNotFoundError'].includes(e.name)) {
      throw new RescheduleError(e.message, chain)
    }

    if (
      e.message.includes('non-final (code 64)') ||
      e.message.includes('invalid opcode: opcode 0xfe not defined')
    ) {
      throw new PossibleTimelockError(e.message, chain)
    }

    throw e
  } finally {
    unlockAsset(chain)
    debug(`Unlocked ${chain} [#${id}] - (Pending: ${[...PENDING[chain]]})`)
  }
}

module.exports = {
  withLock,
  wait,
  waitForRandom
}
