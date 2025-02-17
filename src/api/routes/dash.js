const asyncHandler = require('express-async-handler')
const router = require('express').Router()
const { fromUnixTime, differenceInDays, parseISO, compareAsc, eachDayOfInterval, format } = require('date-fns')

const Market = require('../../models/Market')
const Order = require('../../models/Order')
const MarketHistory = require('../../models/MarketHistory')

const addressHashVariants = address => {
  const addressLowerCase = address.toLowerCase()

  const arr = [address, addressLowerCase]

  if (/0x/i.test(address)) {
    arr.push(...arr.map(item => item.replace(/^0x/, '')))
  } else {
    arr.push(...arr.map(item => `0x${item}`))
  }

  return [...new Set(arr)]
}

router.get('/orders', asyncHandler(async (req, res) => {
  const { q, from, to, start, end, status, excludeStatus, userAgent, pending } = req.query
  let { limit, page, sort } = req.query

  try {
    page = parseInt(page)
    if (!page || page < 1) throw new Error('Invalid page')
  } catch (e) {
    page = 1
  }

  try {
    limit = parseInt(limit)
    if (!limit || limit < 1 || limit > 25) throw new Error('Invalid limit')
  } catch (e) {
    limit = 25
  }

  if (!sort) sort = '-createdAt'

  const query = {}

  if (userAgent && userAgent.length !== 2) {
    if (userAgent[0] === 'WALLET') {
      query.userAgent = 'wallet'
    } else {
      query.userAgent = { $exists: false }
    }
  }

  if (q) {
    const inAddresses = { $in: addressHashVariants(q) }

    query.$or = [
      { orderId: inAddresses },

      { fromCounterPartyAddress: inAddresses },
      { toCounterPartyAddress: inAddresses },
      { fromAddress: inAddresses },
      { toAddress: inAddresses },

      { fromFundHash: inAddresses },
      { fromSecondaryFundHash: inAddresses },
      { fromClaimHash: inAddresses },
      { toFundHash: inAddresses },
      { toSecondaryFundHash: inAddresses },
      { toRefundHash: inAddresses },

      { secretHash: inAddresses }
    ]
  }

  if (from && from.length > 0) {
    query.from = { $in: from }
  }

  if (to && to.length > 0) {
    query.to = { $in: to }
  }

  if (status && status.length > 0) {
    query.status = { $in: status }
  } else if (excludeStatus && excludeStatus.length > 0) {
    query.status = { $nin: excludeStatus }
  }

  if (start) {
    query.createdAt = { $gte: new Date(Number(start)) }
  }

  if (end) {
    if (!query.createdAt) query.createdAt = {}

    query.createdAt.$lte = new Date(Number(end))
  }

  if (pending) {
    if (pending.length === 2) {
      query.hasUnconfirmedTx = true
    } else if (pending[0] === 'USER') {
      query.hasUserUnconfirmedTx = true
    } else {
      query.hasAgentUnconfirmedTx = true
    }
  }

  const result = await Order.find(query, null, {
    sort,
    skip: limit * (page - 1),
    limit
  }).exec()

  res.json({
    page,
    count: result.length,
    result
  })
}))

router.get('/rate', asyncHandler(async (req, res) => {
  const { market, timestamp } = req.query

  const rate = await MarketHistory.getRateNear(market, timestamp)

  res.json({
    result: rate
  })
}))

router.get('/statsByAddress', asyncHandler(async (req, res) => {
  const { address } = req.query

  const inAddresses = { $in: addressHashVariants(address) }

  const _result = await Order.aggregate([
    {
      $match: {
        status: 'AGENT_CLAIMED',
        $or: [
          { fromCounterPartyAddress: inAddresses },
          { toCounterPartyAddress: inAddresses },
          { fromAddress: inAddresses },
          { toAddress: inAddresses }
        ]
      }
    },
    {
      $group: {
        _id: null,
        'sum:fromAmountUsd': { $sum: '$fromAmountUsd' },
        'sum:toAmountUsd': { $sum: '$toAmountUsd' },
        count: { $sum: 1 }
      }
    }
  ]).exec()

  const result = _result[0] || {}

  res.json({
    address,
    result
  })
}))

router.get('/topAddresses', asyncHandler(async (req, res) => {
  let { sort, page, limit } = req.query

  try {
    page = parseInt(page)
    if (!page || page < 1) throw new Error('Invalid page')
  } catch (e) {
    page = 1
  }

  try {
    limit = parseInt(limit)
    if (!limit || limit < 1 || limit > 25) throw new Error('Invalid limit')
  } catch (e) {
    limit = 25
  }

  if (!sort) sort = 'volume'

  const sortKey = sort.endsWith('volume')
    ? 'sum:fromAmountUsd'
    : 'count'

  const _result = await Order.aggregate([
    {
      $match: {
        status: 'AGENT_CLAIMED'
      }
    },
    {
      $addFields: {
        market: { $concat: ['$from', '-', '$to'] }
      }
    },
    {
      $group: {
        _id: '$fromAddress',
        'sum:fromAmountUsd': { $sum: '$fromAmountUsd' },
        'sum:toAmountUsd': { $sum: '$toAmountUsd' },
        markets: { $addToSet: '$market' },
        count: { $sum: 1 }
      }
    },
    {
      $sort: { [sortKey]: sort.startsWith('-') ? -1 : 1 }
    },
    {
      $skip: limit * (page - 1)
    },
    {
      $limit: limit
    }
  ]).exec()

  const result = _result.map(r => {
    r.address = r._id
    delete r._id

    return r
  })

  res.json({
    count: result.length,
    result
  })
}))

router.get('/stats', asyncHandler(async (req, res) => {
  let { start, end, address } = req.query
  start = new Date(Number(start))
  end = new Date(Number(end))

  const markets = (await Market.find({}, 'from to').exec()).map(market => `${market.from}-${market.to}`)

  const $group = markets.reduce((acc, market) => {
    acc[`market:${market}:sum:fromAmountUsd`] = { $sum: { $cond: [{ $eq: ['$market', market] }, '$fromAmountUsd', 0] } }
    acc[`market:${market}:sum:toAmountUsd`] = { $sum: { $cond: [{ $eq: ['$market', market] }, '$toAmountUsd', 0] } }
    acc[`market:${market}:count`] = { $sum: { $cond: [{ $eq: ['$market', market] }, 1, 0] } }

    return acc
  }, {})

  const $match = {
    status: 'AGENT_CLAIMED',
    createdAt: {
      $gte: start,
      $lte: end
    }
  }

  if (address) {
    const inAddresses = { $in: addressHashVariants(address) }

    $match.$or = [
      { fromCounterPartyAddress: inAddresses },
      { toCounterPartyAddress: inAddresses },
      { fromAddress: inAddresses },
      { toAddress: inAddresses }
    ]
  }

  const result = await Order.aggregate([
    {
      $match
    },
    {
      $addFields: {
        market: { $concat: ['$from', '-', '$to'] },
        date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }
      }
    },
    {
      $group: {
        _id: '$date',
        ...$group,
        'wallet:sum:fromAmountUsd': { $sum: { $cond: [{ $eq: ['$userAgent', 'wallet'] }, '$fromAmountUsd', 0] } },
        'wallet:sum:toAmountUsd': { $sum: { $cond: [{ $eq: ['$userAgent', 'wallet'] }, '$toAmountUsd', 0] } },
        'wallet:count': { $sum: { $cond: [{ $eq: ['$userAgent', 'wallet'] }, 1, 0] } },
        'sum:totalAgentFeeUsd': { $sum: '$totalAgentFeeUsd' },
        'sum:totalUserFeeUsd': { $sum: '$totalUserFeeUsd' },
        'sum:fromAmountUsd': { $sum: '$fromAmountUsd' },
        'sum:toAmountUsd': { $sum: '$toAmountUsd' },
        count: { $sum: 1 }
      }
    }
  ]).exec()

  const stats = result.map(json => {
    json.date = json._id
    delete json._id

    json.markets = Object.entries(json)
      .filter(([key]) => key.startsWith('market:'))
      .reduce((acc, [key, value]) => {
        const arr = key.split(':')
        arr.shift() // discard 'market'

        const market = arr.shift()
        const type = arr.join(':')

        if (!acc[market]) acc[market] = {}
        acc[market][type] = value

        return acc
      }, {})

    return json
  })

  const emptyDataPoint = {
    'wallet:sum:fromAmountUsd': 0,
    'wallet:sum:toAmountUsd': 0,
    'wallet:count': 0,
    'sum:totalAgentFeeUsd': 0,
    'sum:totalUserFeeUsd': 0,
    'sum:fromAmountUsd': 0,
    'sum:toAmountUsd': 0,
    count: 0
  }

  eachDayOfInterval({
    start: start,
    end: end
  }).forEach(date => {
    date = format(date, 'yyyy-MM-dd')
    if (stats.find(stat => stat.date === date)) return

    stats.push({
      date,
      ...emptyDataPoint
    })
  })

  stats.sort((a, b) => compareAsc(parseISO(a.date), parseISO(b.date)))

  res.json({
    count: result.length,
    result: {
      markets,
      stats
    }
  })
}))

router.get('/rates', asyncHandler(async (req, res) => {
  const { market, start, end } = req.query

  if (!market) return res.notOk(400, 'Value not specified: market')
  if (!start) return res.notOk(400, 'Value not specified: start')
  if (!end) return res.notOk(400, 'Value not specified: end')
  if (start >= end) return res.notOk(400, 'Invalid values: start should be <= end')

  const diff = differenceInDays(fromUnixTime(end), fromUnixTime(start))
  if (diff > 30) return res.notOk(400, 'Range cannot exceed 30 days')

  const result = await MarketHistory.getRates(market, start, end)

  res.json({
    count: result.length,
    result
  })
}))

router.get('/accumulate', asyncHandler(async (req, res) => {
  const [result] = await Order.aggregate([
    {
      $match: {
        status: 'AGENT_CLAIMED'
      }
    },
    {
      $group: {
        _id: null,
        'sum:fromAmountUsd': { $sum: '$fromAmountUsd' },
        'sum:toAmountUsd': { $sum: '$toAmountUsd' },
        count: { $sum: 1 }
      }
    }
  ]).exec()

  res.json({
    result
  })
}))

module.exports = router
