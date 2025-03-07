'use strict'

/**
 * @module nock/intercepts
 */

const RequestOverrider = require('./request_overrider')
const common = require('./common')
const { inherits } = require('util')
const Interceptor = require('./interceptor')
const http = require('http')
const _ = require('lodash')
const debug = require('debug')('nock.intercept')
const globalEmitter = require('./global_emitter')
const timers = require('timers')

/**
 * @name NetConnectNotAllowedError
 * @private
 * @desc Error trying to make a connection when disabled external access.
 * @class
 * @example
 * nock.disableNetConnect();
 * http.get('http://zombo.com');
 * // throw NetConnectNotAllowedError
 */
function NetConnectNotAllowedError(host, path) {
  Error.call(this)

  this.name = 'NetConnectNotAllowedError'
  this.code = 'ENETUNREACH'
  this.message = `Nock: Disallowed net connect for "${host}${path}"`

  Error.captureStackTrace(this, this.constructor)
}

inherits(NetConnectNotAllowedError, Error)

let allInterceptors = {}
let allowNetConnect

/**
 * Enabled real request.
 * @public
 * @param {String|RegExp} matcher=RegExp.new('.*') Expression to match
 * @example
 * // Enables all real requests
 * nock.enableNetConnect();
 * @example
 * // Enables real requests for url that matches google
 * nock.enableNetConnect('google');
 * @example
 * // Enables real requests for url that matches google and amazon
 * nock.enableNetConnect(/(google|amazon)/);
 */
function enableNetConnect(matcher) {
  if (_.isString(matcher)) {
    allowNetConnect = new RegExp(matcher)
  } else if (_.isObject(matcher) && _.isFunction(matcher.test)) {
    allowNetConnect = matcher
  } else {
    allowNetConnect = /.*/
  }
}

function isEnabledForNetConnect(options) {
  common.normalizeRequestOptions(options)

  const enabled = allowNetConnect && allowNetConnect.test(options.host)
  debug('Net connect', enabled ? '' : 'not', 'enabled for', options.host)
  return enabled
}

/**
 * Disable all real requests.
 * @public
 * @example
 * nock.disableNetConnect();
 */
function disableNetConnect() {
  allowNetConnect = undefined
}

function isOn() {
  return !isOff()
}

function isOff() {
  return process.env.NOCK_OFF === 'true'
}

function add(key, interceptor, scope, scopeOptions, host) {
  if (!(key in allInterceptors)) {
    allInterceptors[key] = { key, scopes: [] }
  }
  interceptor.__nock_scope = scope

  //  We need scope's key and scope options for scope filtering function (if defined)
  interceptor.__nock_scopeKey = key
  interceptor.__nock_scopeOptions = scopeOptions
  //  We need scope's host for setting correct request headers for filtered scopes.
  interceptor.__nock_scopeHost = host
  interceptor.interceptionCounter = 0

  if (scopeOptions.allowUnmocked) allInterceptors[key].allowUnmocked = true

  allInterceptors[key].scopes.push(interceptor)
}

function remove(interceptor) {
  if (interceptor.__nock_scope.shouldPersist() || --interceptor.counter > 0) {
    return
  }

  const { basePath } = interceptor
  const interceptors =
    (allInterceptors[basePath] && allInterceptors[basePath].scopes) || []

  // TODO: There is a clearer way to write that we want to delete the first
  // matching instance. I'm also not sure why we couldn't delete _all_
  // matching instances.
  interceptors.some(function(thisInterceptor, i) {
    return thisInterceptor === interceptor ? interceptors.splice(i, 1) : false
  })
}

function removeAll() {
  Object.keys(allInterceptors).forEach(function(key) {
    allInterceptors[key].scopes.forEach(function(interceptor) {
      interceptor.scope.keyedInterceptors = {}
    })
  })
  allInterceptors = {}
}

/**
 * Return all the Interceptors whose Scopes match against the base path of the provided options.
 *
 * @returns {Interceptor[]}
 */
function interceptorsFor(options) {
  common.normalizeRequestOptions(options)

  debug('interceptors for %j', options.host)

  const basePath = `${options.proto}://${options.host}`

  debug('filtering interceptors for basepath', basePath)

  //  First try to use filteringScope if any of the interceptors has it defined.
  let matchingInterceptor
  _.each(allInterceptors, function(interceptor) {
    _.each(interceptor.scopes, function(scope) {
      const { filteringScope } = scope.__nock_scopeOptions

      //  If scope filtering function is defined and returns a truthy value
      //  then we have to treat this as a match.
      if (filteringScope && filteringScope(basePath)) {
        debug('found matching scope interceptor')

        //  Keep the filtered scope (its key) to signal the rest of the module
        //  that this wasn't an exact but filtered match.
        scope.__nock_filteredScope = scope.__nock_scopeKey
        matchingInterceptor = interceptor.scopes
        //  Break out of _.each for scopes.
        return false
      }
    })

    if (
      !matchingInterceptor &&
      common.matchStringOrRegexp(basePath, interceptor.key)
    ) {
      if (interceptor.scopes.length === 0 && interceptor.allowUnmocked) {
        matchingInterceptor = [
          {
            options: { allowUnmocked: true },
            matchAddress() {
              return false
            },
          },
        ]
      } else {
        matchingInterceptor = interceptor.scopes
      }
      // false to short circuit the .each
      return false
    }

    //  Returning falsy value here (which will happen if we have found our matching interceptor)
    //  will break out of _.each for all interceptors.
    return !matchingInterceptor
  })

  return matchingInterceptor
}

function removeInterceptor(options) {
  let baseUrl, key, method, proto
  if (options instanceof Interceptor) {
    baseUrl = options.basePath
    key = options._key
  } else {
    proto = options.proto ? options.proto : 'http'

    common.normalizeRequestOptions(options)
    baseUrl = `${proto}://${options.host}`
    method = (options.method && options.method.toUpperCase()) || 'GET'
    key = `${method} ${baseUrl}${options.path || '/'}`
  }

  if (allInterceptors[baseUrl] && allInterceptors[baseUrl].scopes.length > 0) {
    for (let i = 0; i < allInterceptors[baseUrl].scopes.length; i++) {
      const interceptor = allInterceptors[baseUrl].scopes[i]
      if (interceptor._key === key) {
        allInterceptors[baseUrl].scopes.splice(i, 1)
        interceptor.scope.remove(key, interceptor)
        break
      }
    }

    return true
  }

  return false
}
//  Variable where we keep the ClientRequest we have overridden
//  (which might or might not be node's original http.ClientRequest)
let originalClientRequest

function ErroringClientRequest(error) {
  http.OutgoingMessage.call(this)
  process.nextTick(
    function() {
      this.emit('error', error)
    }.bind(this)
  )
}

inherits(ErroringClientRequest, http.ClientRequest)

function overrideClientRequest() {
  // Here's some background discussion about overriding ClientRequest:
  // - https://github.com/nodejitsu/mock-request/issues/4
  // - https://github.com/nock/nock/issues/26
  // It would be good to add a comment that explains this more clearly.
  debug('Overriding ClientRequest')

  // ----- Extending http.ClientRequest

  //  Define the overriding client request that nock uses internally.
  function OverriddenClientRequest(...args) {
    const { options, callback } = common.normalizeClientRequestArgs(...args)

    if (Object.keys(options).length === 0) {
      // As weird as it is, it's possible to call `http.request` without
      // options, and it makes a request to localhost or somesuch. We should
      // support it too, for parity. However it doesn't work today, and fixing
      // it seems low priority. Giving an explicit error is nicer than
      // crashing with a weird stack trace. `http[s].request()`, nock's other
      // client-facing entry point, makes a similar check.
      // https://github.com/nock/nock/pull/1386
      // https://github.com/nock/nock/pull/1440
      throw Error(
        'Creating a ClientRequest with empty `options` is not supported in Nock'
      )
    }

    http.OutgoingMessage.call(this)

    //  Filter the interceptors per request options.
    const interceptors = interceptorsFor(options)

    if (isOn() && interceptors) {
      debug('using', interceptors.length, 'interceptors')

      //  Use filtered interceptors to intercept requests.
      const overrider = RequestOverrider(this, options, interceptors, remove)
      Object.assign(this, overrider)

      if (callback) {
        this.once('response', callback)
      }
    } else {
      debug('falling back to original ClientRequest')

      //  Fallback to original ClientRequest if nock is off or the net connection is enabled.
      if (isOff() || isEnabledForNetConnect(options)) {
        originalClientRequest.apply(this, arguments)
      } else {
        timers.setImmediate(
          function() {
            const error = new NetConnectNotAllowedError(
              options.host,
              options.path
            )
            this.emit('error', error)
          }.bind(this)
        )
      }
    }
  }
  inherits(OverriddenClientRequest, http.ClientRequest)

  //  Override the http module's request but keep the original so that we can use it and later restore it.
  //  NOTE: We only override http.ClientRequest as https module also uses it.
  originalClientRequest = http.ClientRequest
  http.ClientRequest = OverriddenClientRequest

  debug('ClientRequest overridden')
}

function restoreOverriddenClientRequest() {
  debug('restoring overridden ClientRequest')

  //  Restore the ClientRequest we have overridden.
  if (!originalClientRequest) {
    debug('- ClientRequest was not overridden')
  } else {
    http.ClientRequest = originalClientRequest
    originalClientRequest = undefined

    debug('- ClientRequest restored')
  }
}

function isActive() {
  //  If ClientRequest has been overwritten by Nock then originalClientRequest is not undefined.
  //  This means that Nock has been activated.
  return !_.isUndefined(originalClientRequest)
}

function interceptorScopes() {
  return _.reduce(
    allInterceptors,
    function(result, interceptors) {
      for (const interceptor in interceptors.scopes) {
        result = result.concat(interceptors.scopes[interceptor].__nock_scope)
      }

      return result
    },
    []
  )
}

function isDone() {
  return _.every(interceptorScopes(), function(scope) {
    return scope.isDone()
  })
}

function pendingMocks() {
  return _.flatten(
    _.map(interceptorScopes(), function(scope) {
      return scope.pendingMocks()
    })
  )
}

function activeMocks() {
  return _.flatten(
    _.map(interceptorScopes(), function(scope) {
      return scope.activeMocks()
    })
  )
}

function activate() {
  if (originalClientRequest) {
    throw new Error('Nock already active')
  }

  overrideClientRequest()

  // ----- Overriding http.request and https.request:

  common.overrideRequests(function(proto, overriddenRequest, args) {
    //  NOTE: overriddenRequest is already bound to its module.

    const { options, callback } = common.normalizeClientRequestArgs(...args)

    if (Object.keys(options).length === 0) {
      // As weird as it is, it's possible to call `http.request` without
      // options, and it makes a request to localhost or somesuch. We should
      // support it too, for parity. However it doesn't work today, and fixing
      // it seems low priority. Giving an explicit error is nicer than
      // crashing with a weird stack trace. `new ClientRequest()`, nock's
      // other client-facing entry point, makes a similar check.
      // https://github.com/nock/nock/pull/1386
      // https://github.com/nock/nock/pull/1440
      throw Error(
        'Making a request with empty `options` is not supported in Nock'
      )
    }

    // The option per the docs is `protocol`. Its unclear if this line is meant to override that and is misspelled or if
    // the intend is to explicitly keep track of which module was called using a separate name.
    // Either way, `proto` is used as the source of truth from here on out.
    options.proto = proto

    const interceptors = interceptorsFor(options)

    if (isOn() && interceptors) {
      const matches = !!_.find(interceptors, function(interceptor) {
        return interceptor.matchAddress(options)
      })

      const allowUnmocked = !!_.find(interceptors, function(interceptor) {
        return interceptor.options.allowUnmocked
      })

      if (!matches && allowUnmocked) {
        let req
        if (proto === 'https') {
          const { ClientRequest } = http
          http.ClientRequest = originalClientRequest
          req = overriddenRequest(options, callback)
          http.ClientRequest = ClientRequest
        } else {
          req = overriddenRequest(options, callback)
        }
        globalEmitter.emit('no match', req)
        return req
      }

      //  NOTE: Since we already overrode the http.ClientRequest we are in fact constructing
      //    our own OverriddenClientRequest.
      return new http.ClientRequest(options, callback)
    } else {
      globalEmitter.emit('no match', options)
      if (isOff() || isEnabledForNetConnect(options)) {
        return overriddenRequest(options, callback)
      } else {
        const error = new NetConnectNotAllowedError(options.host, options.path)
        return new ErroringClientRequest(error)
      }
    }
  })
}

activate()

module.exports = add
module.exports.removeAll = removeAll
module.exports.removeInterceptor = removeInterceptor
module.exports.isOn = isOn
module.exports.activate = activate
module.exports.isActive = isActive
module.exports.isDone = isDone
module.exports.pendingMocks = pendingMocks
module.exports.activeMocks = activeMocks
module.exports.enableNetConnect = enableNetConnect
module.exports.disableNetConnect = disableNetConnect
module.exports.overrideClientRequest = overrideClientRequest
module.exports.restoreOverriddenClientRequest = restoreOverriddenClientRequest
