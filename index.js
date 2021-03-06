const {
  merge
} = require('lodash')
const admin = require('firebase-admin')
const bluebird = require('bluebird')
const moment = require('moment')
const redis = require('redis')
const {
  sprintf
} = require('sprintf-js')
const {
  MongoClient
} = require('mongodb')

const options = require('./options')
const {
  getAccessToken,
  getFID,
  throwError,
  lower
} = require('./helpers')(options)

bluebird.promisifyAll(redis.RedisClient.prototype)
bluebird.promisifyAll(redis.Multi.prototype)

const datetimeFormat = 'MM/DD/YYYY HH:mm:ss'
let redisClient
let User
let userInfo

const handleError = (ctx, e) => {
  const status = (!e.statusCode ? 401 : e.statusCode)

  ctx.status = status
  ctx.body = {
    error: {
      status,
      message: e.message
    }
  }

  return true
}
const init = (_options = {}) => {
  merge(options, _options)

  admin.initializeApp({
    credential: admin.credential.cert(options.credential),
    databaseURL: options.databaseURL
  })
}

const connectRedis = async () => {
  redisClient = await redis.createClient({
    url: options.redis.url
  })

  return redisClient
}

const verifyAccessToken = async (ctx, next) => {
  try {
    const accessToken = getAccessToken(ctx)
    const fid = getFID(ctx)

    redisClient = await connectRedis()
    const getRedisKey = sprintf(options.redis.storeKey, {
      fid
    })
    const redisValue = await redisClient.getAsync(getRedisKey)
    if (redisValue) {
      ctx.user = JSON.parse(redisValue)
      return next()
    }

    const db = await MongoClient.connect(options.mongo.url)
    User = db.collection(options.mongo.userCollection)

    const authData = await admin.auth()
      .verifyIdToken(accessToken)
    if (authData.uid !== fid) {
      throwError(lower('Unauthorized.'), 401)
    }

    const redisKey = sprintf(options.redis.storeKey, {
      fid: authData.uid
    })
    const nowTime = moment(moment()
      .format(datetimeFormat), datetimeFormat)
    const expTime = moment.unix(authData.exp, datetimeFormat)
    const redisTTL = Math.round(((expTime.diff(nowTime) / 1000) / 60) * 60)

    userInfo = await User.findOne({
      [`${options.mongo.fields.authFirebase}.${options.mongo.fields.fid}`]: fid
    })

    if (!userInfo) {
      userInfo = await User.insert({
        [options.mongo.fields.authFirebase]: {
          [options.mongo.fields.fid]: fid
        },
        [options.mongo.fields.createdAt]: new Date()
      })
      userInfo = userInfo.ops[0]
    }

    const dataContext = {
      accessToken,
      fid,
      ...userInfo
    }
    redisClient.set(redisKey, JSON.stringify(dataContext), 'EX', redisTTL)
    ctx.user = dataContext

    return next()
  } catch (e) {
    return handleError(ctx, e)
  }
}

const passUserContext = async (ctx, next) => {
  try {
    const fid = getFID(ctx, {
      skipThrowError: true
    })
    if (!fid) {
      return next()
    }

    redisClient = await connectRedis()
    const redisStoreKey = sprintf(options.redis.storeKey, {
      fid
    })
    const redisValue = await redisClient.getAsync(redisStoreKey)
    if (redisValue) {
      ctx.user = JSON.parse(redisValue)
    }

    return next()
  } catch (e) {
    return handleError(ctx, e)
  }
}

const moduleExports = {
  init,
  verifyAccessToken,
  passUserContext
}

module.exports = moduleExports
