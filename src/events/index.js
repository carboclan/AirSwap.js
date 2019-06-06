const _ = require('lodash')
const ethers = require('ethers')
const {
  AST_CONTRACT_ADDRESS, //eslint-disable-line
  ERC20abi,
  AIRSWAP_GETH_NODE_ADDRESS,
  abis,
  SWAP_LEGACY_CONTRACT_ADDRESS,
} = require('../constants')
const { getLogs, BlockTracker } = require('../utils/gethRead')

const provider = new ethers.providers.JsonRpcProvider(AIRSWAP_GETH_NODE_ADDRESS)

const queries = {}

async function fetchLogs(contractAddress, abi, topic, fromBlock, toBlock) {
  const toBlockOverride = toBlock || (await provider.getBlockNumber())
  const fromBlockOverride = fromBlock || Number(toBlockOverride) - 7000 // default is around 1 day of blocks

  let topicParam
  if (topic) {
    if (_.isArray(topic)) {
      topicParam = topic
    } else {
      topicParam = [topic]
    }
  }

  const query = {
    address: contractAddress || undefined,
    topics: topicParam,
  }

  let logs
  try {
    logs = await getLogs([
      {
        ...query,
        fromBlock: ethers.utils.hexlify(fromBlockOverride),
        toBlock: ethers.utils.hexlify(toBlockOverride),
      },
    ])
  } catch (e) {
    console.log('error fetching logs from geth', e)
    return
  }

  return parseEventLogs(logs)
}

const abiInterfaces = {}

function parseEventLogs(logs) {
  return _.compact(
    logs.map(log => {
      let abiInterface
      if (abiInterfaces[log.address]) {
        abiInterface = abiInterfaces[log.address]
      } else {
        abiInterface = new ethers.utils.Interface(abis[log.address.toLowerCase()])
        abiInterfaces[log.address] = abiInterface
      }
      let parsedLog
      try {
        parsedLog = abiInterface.parseLog(log)
      } catch (e) {
        // this was added because ERC721 transactions show up under the Transfer topic but can't be parsed by the human-standard-token abi
        return null
      }

      const parsedLogValues = _.mapValues(parsedLog.values, v => ((v.toString ? v.toString() : v) || '').toLowerCase()) // converts bignumbers to strings and lowercases everything (most importantly addresses)
      const argumentRange = _.range(Number(parsedLogValues.length)).map(p => p.toString())
      const formattedLogValues = _.pickBy(
        parsedLogValues,
        (param, key) => !_.includes(argumentRange, key) && key !== 'length', // removes some extra junk ethers puts in the parsed logs
      )
      const { address, topics, data, blockNumber, transactionHash, removed } = log
      const { name, signature, topic } = parsedLog
      return {
        ...{
          address,
          topics,
          data,
          blockNumber: ethers.utils.bigNumberify(blockNumber).toNumber(),
          transactionHash,
          removed,
        },
        ...{ name, signature, topic },
        values: formattedLogValues,
        parsedLogValues,
      }
    }),
  )
}

async function pollLogs(successCallback, failureCallback, contractAddress, abi, topic) {
  const query = {
    contractAddress,
    abi,
    topic,
  }
  queries[JSON.stringify(query)] = {
    query,
    successCallback,
  }
}

async function fetchAndPollLogs(successCallback, failureCallback, contractAddress, abi, topic, fromBlock) {
  fetchLogs(contractAddress, abi, topic, fromBlock)
    .then(batchLogs => {
      successCallback(batchLogs)
      pollLogs(successCallback, failureCallback, contractAddress, abi, topic)
    })
    .catch(e => failureCallback(e))
}

function fetchExchangeLogs(eventName, fromBlock, toBlock) {
  const abiInterface = new ethers.utils.Interface(abis[SWAP_LEGACY_CONTRACT_ADDRESS])
  const topic = eventName ? abiInterface.events[eventName].topic : null
  return fetchLogs(SWAP_LEGACY_CONTRACT_ADDRESS, abis[SWAP_LEGACY_CONTRACT_ADDRESS], topic, fromBlock, toBlock)
}

function fetchERC20Logs(contractAddress, eventName, fromBlock, toBlock) {
  const abiInterface = new ethers.utils.Interface(ERC20abi)
  const topic = eventName ? abiInterface.events[eventName].topic : null
  return fetchLogs(contractAddress, ERC20abi, topic, fromBlock, toBlock)
}

async function fetchGlobalERC20Transfers(addresses, fromBlock, toBlock) {
  const erc20ABIInterface = new ethers.utils.Interface(ERC20abi)
  const addressTopics = addresses.map(address =>
    _.last(erc20ABIInterface.events.Transfer.encodeTopics([address.toLowerCase()])),
  )

  const fromTopics = [erc20ABIInterface.events.Transfer.topic, addressTopics, null]
  const toTopics = [erc20ABIInterface.events.Transfer.topic, null, addressTopics]
  const events = _.flatten(
    await Promise.all([
      fetchLogs(null, ERC20abi, fromTopics, fromBlock, toBlock),
      fetchLogs(null, ERC20abi, toTopics, fromBlock, toBlock),
    ]),
  )
  return _.uniqBy(
    events,
    ({ parsedLogValues, transactionHash }) =>
      `${transactionHash}${parsedLogValues[0]}${parsedLogValues[1]}${parsedLogValues[2]}`, // generates unique id for transfer event, since one transactionHash can have multiple transfers
  )
}

// EXAMPLES
//
// ** fetch all ERC20 Approvals **
// fetchERC20Logs(null, 'Approval')
//   .then(console.log)
//   .catch(console.log)
//
// ** fetch all AST transfers **
// fetchERC20Logs(AST_CONTRACT_ADDRESS, 'Transfer')
//   .then(console.log)
//   .catch(console.log)
//
// ** fetch all Airswap Exchange Contract events  **
// fetchExchangeLogs()
//   .then(console.log)
//   .catch(console.log)
//
// ** fetch global ERC20 transfer events for eth addresses passed in  **
//  fetchGlobalERC20Transfers(['0xDead0717B16b9F56EB6e308E4b29230dc0eEE0B6', '0x1550d41be3651686e1aeeea073d8d403d0bd2e30'])
//   .then(console.log)
//   .catch(console.log)

const blockTracker = new BlockTracker(block => processNewBlock(block)) //eslint-disable-line

function processNewBlock(block) {
  const blockNumber = block.number
  const fromBlock = blockNumber
  const toBlock = blockNumber

  _.mapValues(queries, async query => {
    if (_.isObject(query)) {
      const {
        query: { contractAddress, abi, topic },
        successCallback,
        failureCallback,
      } = query
      if (
        contractAddress &&
        !_.find(block.transactions, ({ to }) => (to || '').toLowerCase() === contractAddress.toLowerCase())
      ) {
        return
      }

      fetchLogs(contractAddress, abi, topic, fromBlock, toBlock)
        .then(logs => successCallback(logs))
        .catch(e => failureCallback(e))
    }
  })
}

module.exports = { fetchLogs, pollLogs, fetchAndPollLogs, fetchExchangeLogs, fetchERC20Logs, fetchGlobalERC20Transfers }
