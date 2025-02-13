const ethers = require('ethers')
const utils = require('web3-utils')
const { constants, getOrderHash } = require('../utils/orderUtils')
const { SWAP_CONTRACT_ADDRESS, ETH_ADDRESS, abis } = require('../constants')

function getSwapContract(signer) {
  return new ethers.Contract(SWAP_CONTRACT_ADDRESS, abis[SWAP_CONTRACT_ADDRESS], signer)
}

async function swap(orderParams, signer) {
  const {
    version,
    signer: signerAddress,
    r,
    s,
    v,
    nonce,
    makerWallet,
    makerParam,
    makerToken,
    takerWallet,
    takerParam,
    takerToken,
    expiry,
  } = orderParams

  const signature = {
    version,
    signer: signerAddress,
    r,
    s,
    v,
  }
  const order = {
    expiry,
    nonce,
    maker: { wallet: makerWallet.toLowerCase(), token: makerToken, param: makerParam, kind },
    taker: { wallet: takerWallet.toLowerCase(), token: takerToken, param: takerParam, kind },
    affiliate: constants.defaults.Party,
  }

  const contract = getSwapContract(signer)
  return contract.swap(order, signature, {
    value: ethers.utils.bigNumberify(takerToken === ETH_ADDRESS ? takerParam : 0),
  })
}

const { kind } = constants.defaults.Party

async function signSwap(orderParams, signer) {
  const { nonce, makerWallet, makerParam, makerToken, takerWallet, takerParam, takerToken, expiry } = orderParams

  const takerWalletAddress = takerWallet ? takerWallet.toLowerCase() : constants.defaults.Party.wallet

  const order = {
    nonce,
    expiry,
    maker: { wallet: makerWallet.toLowerCase(), token: makerToken, param: makerParam, kind },
    taker: {
      wallet: takerWalletAddress,
      token: takerToken,
      param: takerParam,
      kind,
    },
    affiliate: constants.defaults.Party,
  }

  const orderHashHex = getOrderHash(order, SWAP_CONTRACT_ADDRESS)
  const signedMsg = await signer.signMessage(ethers.utils.arrayify(orderHashHex))
  const sig = ethers.utils.splitSignature(signedMsg)
  const signerAddress = await signer.getAddress()
  const { r, s, v } = sig

  return {
    ...orderParams,
    takerWallet: takerWalletAddress,
    signer: signerAddress.toLowerCase(),
    version: '0x45', // Version 0x45: personal_sign
    r,
    s,
    v,
  }
}

async function signSwapTypedData(orderParams, signer) {
  const { nonce, makerWallet, makerParam, makerToken, takerWallet, takerParam, takerToken, expiry } = orderParams
  const takerWalletAddress = takerWallet ? takerWallet.toLowerCase() : constants.defaults.Party.wallet
  const order = {
    expiry,
    nonce,
    maker: { wallet: makerWallet.toLowerCase(), token: makerToken, param: makerParam, kind },
    taker: {
      wallet: takerWalletAddress,
      token: takerToken,
      param: takerParam,
      kind,
    },
    affiliate: constants.defaults.Party,
  }
  const data = {
    types: constants.types, // See: @airswap/order-utils/src/constants.js:4
    domain: {
      name: constants.DOMAIN_NAME,
      version: constants.DOMAIN_VERSION,
      verifyingContract: SWAP_CONTRACT_ADDRESS,
    },
    primaryType: 'Order',
    message: order, // remove falsey values on order
  }
  const signerAddress = await signer.getAddress()
  const sig = await signer.signTypedData(data)
  const { r, s, v } = ethers.utils.splitSignature(sig)

  return {
    ...orderParams,
    takerWallet: takerWalletAddress,
    version: '0x01', // Version 0x01: signTypedData
    signer: signerAddress.toLowerCase(),
    r,
    s,
    v,
  }
}

function swapSimple(order, signer) {
  const contract = getSwapContract(signer)

  return contract.swapSimple(
    order.nonce,
    order.expiry,
    order.makerWallet,
    order.makerParam,
    order.makerToken,
    order.takerWallet,
    order.takerParam,
    order.takerToken,
    order.v,
    order.r,
    order.s,
    {
      value: ethers.utils.bigNumberify(order.takerToken === ETH_ADDRESS ? order.takerParam : 0),
    },
  )
}

function cancel(ids, signer) {
  const contract = getSwapContract(signer)
  return contract.cancel(ids)
}

async function signSwapSimple(order, signer) {
  const { nonce, makerWallet, makerParam, makerToken, takerWallet, takerParam, takerToken, expiry } = order

  const hashedOrder = utils.soliditySha3(
    // Version 0x00: Data with intended validator (verifyingContract)
    { type: 'bytes1', value: '0x0' },
    { type: 'address', value: SWAP_CONTRACT_ADDRESS },
    { type: 'uint256', value: nonce },
    { type: 'uint256', value: expiry },
    { type: 'address', value: makerWallet },
    { type: 'uint256', value: makerParam },
    { type: 'address', value: makerToken },
    { type: 'address', value: takerWallet },
    { type: 'uint256', value: takerParam },
    { type: 'address', value: takerToken },
  )

  const signedMsg = await signer.signMessage(ethers.utils.arrayify(hashedOrder))

  const sig = ethers.utils.splitSignature(signedMsg)

  return {
    nonce,
    makerWallet,
    makerParam,
    makerToken,
    takerWallet,
    takerParam,
    takerToken,
    expiry,
    ...sig,
  }
}

function getMakerOrderStatus(makerAddress, nonce, signer) {
  const contract = getSwapContract(signer)

  return contract.makerOrderStatus(makerAddress, nonce)
}

module.exports = { swap, swapSimple, cancel, signSwapSimple, signSwapTypedData, signSwap, getMakerOrderStatus }
