import _ from 'lodash'
import BigNumber from 'bignumber.js'
import Router from '../index'
import { getSigner } from '../../wallet/redux/actions'
import { selectors as apiSelectors } from '../../api/redux'
import { selectors as deltaBalancesSelectors } from '../../deltaBalances/redux'
import { selectors as protocolMessagingSelectors } from './reducers'
import { newCheckoutFrame } from './actions'
import { fillOrder } from '../../swapLegacy/redux/actions'
import { getKeySpace } from '../../keySpace/redux/actions'
import { fetchSetDexIndexPrices } from '../../dexIndex/redux/actions'
import { ETH_ADDRESS, IS_INSTANT } from '../../constants'
import { Quote, Order, Swap, SwapQuote } from '../../tcombTypes'
import { fillSwap } from '../../swap/redux/actions'

async function initialzeRouter(store) {
  store.dispatch({ type: 'CONNECTING_ROUTER' })
  const signer = await store.dispatch(getSigner())
  const address = await signer.getAddress()
  let config
  const requireAuthentication = protocolMessagingSelectors.getRouterRequireAuth(store.getState())
  if (requireAuthentication) {
    const keySpace = await store.dispatch(getKeySpace())
    const messageSigner = message => keySpace.sign(message)
    config = { address, keyspace: true, messageSigner, requireAuthentication }
  } else {
    config = { address, requireAuthentication }
  }

  router = new Router(config)
  return router.connect()
}

let router

const gotIntents = (intents, stackId) => ({
  type: 'GOT_CHECKOUT_FRAME_INTENTS',
  intents,
  stackId,
})

const gotOrderResponse = (orderResponse, stackId) => ({
  type: 'GOT_CHECKOUT_FRAME_ORDER_RESPONSE',
  orderResponse,
  stackId,
})

const gotAlternativeOrderResponse = (alternativeOrderResponse, stackId) => ({
  type: 'GOT_CHECKOUT_FRAME_ALTERNATIVE_ORDER_RESPONSE',
  alternativeOrderResponse,
  stackId,
})

const gotLowBalanceOrderResponse = (lowBalanceOrderResponse, stackId) => ({
  type: 'GOT_CHECKOUT_FRAME_LOW_BALANCE_ORDER_RESPONSE',
  lowBalanceOrderResponse,
  stackId,
})

const gotAlternativeQuoteResponse = (alternativeQuoteResponse, stackId) => ({
  type: 'GOT_CHECKOUT_FRAME_ALTERNATIVE_QUOTE_RESPONSE',
  alternativeQuoteResponse,
  stackId,
})

const gotQuoteResponse = (quoteResponse, stackId) => ({
  type: 'GOT_CHECKOUT_FRAME_QUOTE_RESPONSE',
  quoteResponse,
  stackId,
})

const frameTimeoutReached = stackId => ({
  type: 'CHECKOUT_FRAME_TIMEOUT_REACHED',
  stackId,
})

const allIntentsResolved = stackId => ({
  type: 'CHECKOUT_FRAME_ALL_INTENTS_RESOLVED',
  stackId,
})

const orderFetchingTimeout = 3000 // 3 seconds

function intentSupportsQuotes({ supportedMethods }) {
  return _.intersection(supportedMethods, ['getQuote', 'getMaxQuote']).length === 2
}

function isMakerSide(query) {
  return query.makerAmount && !query.takerAmount
}

function isTakerSide(query) {
  return query.takerAmount && !query.makerAmount
}

function takerTokenBalanceIsZero(store, takerToken) {
  const state = store.getState()
  const connectedBalances = deltaBalancesSelectors.getConnectedBalances(state)
  const connectedApprovals = deltaBalancesSelectors.getConnectedApprovals(state)
  if (!connectedApprovals) {
    return false
  }
  const tokenApproved = takerToken === ETH_ADDRESS || connectedApprovals[takerToken]
  return !tokenApproved || Number(connectedBalances[takerToken]) === 0
}

function takerTokenBalanceIsLessThanTakerAmount(store, takerToken, takerAmount) {
  const connectedBalances = deltaBalancesSelectors.getConnectedBalances(store.getState())
  return BigNumber(connectedBalances[takerToken]).lt(takerAmount)
}

async function getOrderTakerTokenWithQuotes(intent, store, action) {
  const { makerToken, takerToken, takerAmount } = action.query
  const makerAddress = intent.connectionAddress || intent.makerAddress
  const swapVersion = intent.swapVersion || 1
  const quotePromise = router.getQuote(makerAddress, { takerAmount, makerToken, takerToken, swapVersion })
  const maxQuotePromise = router.getMaxQuote(makerAddress, { makerToken, takerToken, swapVersion })
  let maxQuote
  let quote

  try {
    const maxQuoteResponse = await maxQuotePromise
    maxQuote = swapVersion === 2 ? SwapQuote(maxQuoteResponse) : Quote(maxQuoteResponse)
  } catch (e) {
    console.log(e)
  }
  try {
    const quoteResponse = await quotePromise
    quote = swapVersion === 2 ? SwapQuote(quoteResponse) : Quote(quoteResponse)
  } catch (e) {
    console.log(e)
  }

  if (takerTokenBalanceIsZero(store, takerToken)) {
    if (maxQuote && BigNumber(takerAmount).gt(maxQuote.takerAmount)) {
      return store.dispatch(gotAlternativeQuoteResponse(maxQuote, action.stackId))
    } else if (quote) {
      return store.dispatch(gotQuoteResponse(quote, action.stackId))
    }
  } else if (quote && takerTokenBalanceIsLessThanTakerAmount(store, takerToken, quote.takerAmount)) {
    const takerTokenBalance = _.get(deltaBalancesSelectors.getConnectedBalances(store.getState()), takerToken)
    const adjustedTokenBalance = takerToken === ETH_ADDRESS ? `${Number(takerTokenBalance) * 0.9}` : takerTokenBalance // If takerToken is ETH, we leave 10% of their ETH balance to pay for gas
    try {
      const lowBalanceResponse = await router.getOrder(makerAddress, {
        takerAmount: adjustedTokenBalance,
        makerToken,
        takerToken,
        swapVersion,
      })
      const lowBalanceOrder = swapVersion === 2 ? Swap(lowBalanceResponse) : Order(lowBalanceResponse)
      store.dispatch(gotQuoteResponse(quote, action.stackId))
      return store.dispatch(gotLowBalanceOrderResponse(lowBalanceOrder, action.stackId))
    } catch (e) {
      console.log(e)
    }
  }

  if (maxQuote && BigNumber(takerAmount).gt(maxQuote.takerAmount)) {
    try {
      const alternativeOrderResponse = await router.getOrder(makerAddress, {
        takerAmount: maxQuote.takerAmount,
        makerToken,
        takerToken,
        swapVersion,
      })
      const alternativeOrder = swapVersion === 2 ? Swap(alternativeOrderResponse) : Order(alternativeOrderResponse)

      return store.dispatch(gotAlternativeOrderResponse(alternativeOrder, action.stackId))
    } catch (e) {
      console.log(e)
    }
  }

  try {
    const orderResponse = await router.getOrder(makerAddress, { takerAmount, makerToken, takerToken, swapVersion })
    const order = swapVersion === 2 ? Swap(orderResponse) : Order(orderResponse)
    return store.dispatch(gotOrderResponse(order, action.stackId))
  } catch (e) {
    console.log(e)
  }

  return null // If we can't get an order or quote, we simply resolve the async function with nothing
}

async function getOrderMakerTokenWithQuotes(intent, store, action) {
  const { makerToken, takerToken, makerAmount } = action.query
  const makerAddress = intent.connectionAddress || intent.makerAddress
  const swapVersion = intent.swapVersion || 1
  const quotePromise = router.getQuote(makerAddress, { makerAmount, makerToken, takerToken, swapVersion })
  const maxQuotePromise = router.getMaxQuote(makerAddress, { makerToken, takerToken, swapVersion })
  let maxQuote
  let quote
  try {
    const maxQuoteResponse = await maxQuotePromise
    maxQuote = swapVersion === 2 ? SwapQuote(maxQuoteResponse) : Quote(maxQuoteResponse)
  } catch (e) {
    console.log(e)
  }
  try {
    const quoteResponse = await quotePromise
    quote = swapVersion === 2 ? SwapQuote(quoteResponse) : Quote(quoteResponse)
  } catch (e) {
    console.log(e)
  }

  if (takerTokenBalanceIsZero(store, takerToken)) {
    if (maxQuote && BigNumber(makerAmount).gt(maxQuote.makerAmount)) {
      return store.dispatch(gotAlternativeQuoteResponse(maxQuote, action.stackId))
    } else if (quote) {
      return store.dispatch(gotQuoteResponse(quote, action.stackId))
    }
  } else if (quote && takerTokenBalanceIsLessThanTakerAmount(store, takerToken, quote.takerAmount)) {
    const takerTokenBalance = _.get(deltaBalancesSelectors.getConnectedBalances(store.getState()), takerToken)
    const adjustedTokenBalance = takerToken === ETH_ADDRESS ? `${Number(takerTokenBalance) * 0.9}` : takerTokenBalance // If takerToken is ETH, we leave 10% of their ETH balance to pay for gas
    try {
      const lowBalanceResponse = await router.getOrder(makerAddress, {
        takerAmount: adjustedTokenBalance,
        makerToken,
        takerToken,
        swapVersion,
      })
      const lowBalanceOrder = swapVersion === 2 ? Swap(lowBalanceResponse) : Order(lowBalanceResponse)

      store.dispatch(gotQuoteResponse(quote, action.stackId))
      return store.dispatch(gotLowBalanceOrderResponse(lowBalanceOrder, action.stackId))
    } catch (e) {
      console.log(e)
    }
  }

  if (maxQuote && BigNumber(makerAmount).gt(maxQuote.makerAmount)) {
    try {
      const alternativeOrderResponse = await router.getOrder(makerAddress, {
        makerAmount: maxQuote.makerAmount,
        makerToken,
        takerToken,
        swapVersion,
      })
      const alternativeOrder = swapVersion === 2 ? Swap(alternativeOrderResponse) : Order(alternativeOrderResponse)

      return store.dispatch(gotAlternativeOrderResponse(alternativeOrder, action.stackId))
    } catch (e) {
      console.log(e)
    }
  }

  try {
    const orderResponse = await router.getOrder(makerAddress, { makerAmount, makerToken, takerToken, swapVersion })
    const order = swapVersion === 2 ? Swap(orderResponse) : Order(orderResponse)

    return store.dispatch(gotOrderResponse(order, action.stackId))
  } catch (e) {
    console.log(e)
  }

  return null // If we can't get an order or quote, we simply resolve the async function with nothing
}

async function getOrderTakerTokenWithoutQuotes(intent, store, action) {
  const { makerToken, takerToken, takerAmount } = action.query
  const makerAddress = intent.connectionAddress || intent.makerAddress
  const swapVersion = intent.swapVersion || 1
  if (takerAmount && takerTokenBalanceIsLessThanTakerAmount(store, takerToken, takerAmount)) {
    const takerTokenBalance = _.get(deltaBalancesSelectors.getConnectedBalances(store.getState()), takerToken)
    const adjustedTokenBalance = takerToken === ETH_ADDRESS ? `${Number(takerTokenBalance) * 0.9}` : takerTokenBalance // If takerToken is ETH, we leave 10% of their ETH balance to pay for gas
    try {
      const lowBalanceResponse = await router.getOrder(makerAddress, {
        takerAmount: adjustedTokenBalance,
        makerToken,
        takerToken,
        swapVersion,
      })
      const lowBalanceOrder = swapVersion === 2 ? Swap(lowBalanceResponse) : Order(lowBalanceResponse)

      return store.dispatch(gotLowBalanceOrderResponse(lowBalanceOrder, action.stackId))
    } catch (e) {
      console.log(e)
    }
  }

  try {
    const orderResponse = await router.getOrder(makerAddress, { takerAmount, makerToken, takerToken, swapVersion })
    const order = swapVersion === 2 ? Swap(orderResponse) : Order(orderResponse)

    return store.dispatch(gotOrderResponse(order, action.stackId))
  } catch (e) {
    console.log(e)
  }

  return null // If we can't get an order or quote, we simply resolve the async function with nothing
}

async function getOrderMakerTokenWithoutQuotes(intent, store, action) {
  const { makerToken, takerToken, makerAmount } = action.query
  const makerAddress = intent.connectionAddress || intent.makerAddress
  const swapVersion = intent.swapVersion || 1
  try {
    const orderResponse = await router.getOrder(makerAddress, { makerAmount, makerToken, takerToken, swapVersion })
    const order = swapVersion === 2 ? Swap(orderResponse) : Order(orderResponse)

    return store.dispatch(gotOrderResponse(order, action.stackId))
  } catch (e) {
    console.log(e)
  }

  return null // If we can't get an order or quote, we simply resolve the async function with nothing
}

function mapIntentFetchProtocolOrder(intent, store, action) {
  if (intentSupportsQuotes(intent) && isTakerSide(action.query)) {
    return getOrderTakerTokenWithQuotes(intent, store, action)
  } else if (intentSupportsQuotes(intent) && isMakerSide(action.query)) {
    return getOrderMakerTokenWithQuotes(intent, store, action)
  } else if (!intentSupportsQuotes(intent) && isTakerSide(action.query)) {
    return getOrderTakerTokenWithoutQuotes(intent, store, action)
  } else if (!intentSupportsQuotes(intent) && isMakerSide(action.query)) {
    return getOrderMakerTokenWithoutQuotes(intent, store, action)
  }
}

export default function routerMiddleware(store) {
  store.dispatch(newCheckoutFrame())
  return next => action => {
    const state = store.getState()

    switch (action.type) {
      case 'CONNECTED_WALLET':
        if (!protocolMessagingSelectors.getRouterRequireAuth(state) && IS_INSTANT) {
          const routerPromise = initialzeRouter(store).then(() => store.dispatch({ type: 'ROUTER_CONNECTED' }))
          routerPromise.catch(error => store.dispatch({ type: 'ERROR_CONNECTING_ROUTER', error }))
        }
        break
      case 'KEYSPACE_READY':
        if (protocolMessagingSelectors.getRouterRequireAuth(state)) {
          const routerPromise = initialzeRouter(store).then(() => store.dispatch({ type: 'ROUTER_CONNECTED' }))
          routerPromise.catch(error => store.dispatch({ type: 'ERROR_CONNECTING_ROUTER', error }))
        }
        break
      case 'SET_CHECKOUT_FRAME_QUERY':
        action.stackId = protocolMessagingSelectors.getCurrentFrameStackId(state) //eslint-disable-line
        const intents = apiSelectors.getConnectedIndexerIntents(state)
        const { makerToken, takerToken } = action.query
        const filteredIntents = _.filter(intents, { makerToken, takerToken })
        store.dispatch(gotIntents(filteredIntents, action.stackId))
        Promise.all(filteredIntents.map(intent => mapIntentFetchProtocolOrder(intent, store, action))).then(() =>
          store.dispatch(allIntentsResolved(action.stackId)),
        )
        window.setTimeout(() => {
          store.dispatch(frameTimeoutReached(action.stackId))
        }, orderFetchingTimeout)
        break
      case 'FILL_FRAME_BEST_ORDER':
        action.stackId = protocolMessagingSelectors.getCurrentFrameStackId(state) //eslint-disable-line
        const bestOrder =
          protocolMessagingSelectors.getCurrentFrameSelectedOrder(state) ||
          protocolMessagingSelectors.getCurrentFrameBestOrder(state) ||
          protocolMessagingSelectors.getCurrentFrameBestAlternativeOrder(state) ||
          protocolMessagingSelectors.getCurrentFrameBestLowBalanceOrder(state)

        if (bestOrder.swapVersion === 2) {
          store.dispatch(fillSwap(bestOrder))
        } else {
          store.dispatch(fillOrder(bestOrder))
        }
        break
      case 'SELECT_CHECKOUT_FRAME_ORDER':
        action.stackId = protocolMessagingSelectors.getCurrentFrameStackId(state) //eslint-disable-line
        break
      case 'CHECKOUT_FRAME_TIMEOUT_REACHED':
        // once we've hit the cutoff threshold waiting for orders, check the best order on DexIndex
        store.dispatch(fetchSetDexIndexPrices(action.stackId))
        break
      default:
    }
    return next(action)
  }
}
