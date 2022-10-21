const Client = require('rpc-websockets').Client;
const { methods, TypeRegistry, decode, construct, getRegistryBase, getSpecTypes, defineMethod } = require('@substrate/txwrapper-polkadot');
const { Keyring, ApiPromise, WsProvider } = require('@polkadot/api');
const { hexToU8a } = require('@polkadot/util');
const { cryptoWaitReady } = require('@polkadot/util-crypto');
const { types, rpc } = require('./schema');

/*
 * Utilities to create, sign and submit transactions
 */

const { txHash: getTxHash, signedTx: createSignedTx, signingPayload: createSigningPayload } = construct;

// websocket client for testing
let wsClient;

/*
 * CONSTANTS
 */
const SS58_FORMAT = 42;
const CHAIN_NAME = 'Polymesh Testnet';
const NODE_URL = 'wss://testnet-rpc.polymesh.live';
const ADDRESS_TYPE = 'sr25519';

/**
 * internal, ignore this
 */
async function getClient() {
  if (!wsClient) {
    wsClient = await new Promise((resolve, reject) => {
      const ws = new Client(NODE_URL);
  
      ws.on('open', () => {
        resolve(ws);
      })
    });
  }

  return wsClient;
}

/**
 * internal, ignore this
 */
async function makeRpcCall(  
  method,
  params = []
) {
  const client = await getClient();
  const res = await client.call(method, params).catch(err => console.error(err));
  return res;
}

/**
 * Get all the necessary data to build a transaction. You can replace this with your specific internal API
 * 
 * @param {string} callingAddress - address that will sign the transaction
 * 
 * @returns current block data, chain spec, registry, nonce, etc
 */
async function getTxData(  
  callingAddress,
) {
  const [
    { block },
    blockHash,
    genesisHash,
    metadataRpc,
    nonce,
    { specVersion, transactionVersion, specName },
  ] = await Promise.all([
    makeRpcCall('chain_getBlock'),
    makeRpcCall('chain_getBlockHash'),
    makeRpcCall('chain_getBlockHash', [0]),
    makeRpcCall('state_getMetadata'),
    makeRpcCall('system_accountNextIndex', [callingAddress]),
    makeRpcCall('state_getRuntimeVersion')
  ]);

  const chainProperties = {
    ss58Format: SS58_FORMAT,
    tokenDecimals: 6,
    tokenSymbol: 'POLYX',
  };

  const registry = new TypeRegistry();
  registry.setKnownTypes({ types });

  const registryBase = getRegistryBase({
    chainProperties,
    specTypes: getSpecTypes(registry, CHAIN_NAME, specName, specVersion),
    metadataRpc
  });

  const blockNumber = registryBase
    .createType('BlockNumber', block.header.number)
    .toNumber();

  return {
    blockHash,
    blockNumber,
    genesisHash,
    metadataRpc,
    nonce,
    specVersion,
    transactionVersion,
    chainProperties,
    eraPeriod: 64,
    tip: 0,
    registry: registryBase,
  };
}

/**
 * Retrieve a key pair from a private key
 */
async function getKeyPair(privateKey) {
  await cryptoWaitReady();
  const keyring = new Keyring({
    type: ADDRESS_TYPE,
  });
  keyring.setSS58Format(SS58_FORMAT);
  const seed = hexToU8a(privateKey);
  return keyPair = keyring.addFromSeed(seed);
}

/**
 * Creates a serialized transaction by passing `methodArgs` to `method` and signing with `privateKey`
 * 
 * @param {string} privateKey - private key that will sign the transaction
 * @param {Function} method - transaction method that will be called
 * @param {object} methodArgs - arguments that will be passed to the transaction method
 * 
 * @returns {string} serialized transaction
 */
async function constructSerializedTx(privateKey, method, methodArgs) {
  const keyPair = await getKeyPair(privateKey);
  const { address } = keyPair;
  const {
    blockHash,
    blockNumber,
    genesisHash,
    metadataRpc,
    nonce,
    specVersion,
    transactionVersion,      
    eraPeriod,
    tip,
    registry
  } = await getTxData(address);

  const unsignedTx = method(methodArgs, {
    address,
    blockHash,
    blockNumber,
    eraPeriod,
    genesisHash,
    metadataRpc,
    nonce,
    specVersion,
    tip,
    transactionVersion,
  }, {
    metadataRpc,
    registry,
  });

  const signingPayload = createSigningPayload(unsignedTx, { registry });  

  const { signature } = registry.createType('ExtrinsicPayload', signingPayload, { version: unsignedTx.version }).sign(keyPair);

  /* SERIALIZATION */
  const serialized = createSignedTx(unsignedTx, signature, { metadataRpc, registry });  

  console.log('======================');
  console.log('serialized:', serialized);
  console.log('txHash:', getTxHash(serialized));
  console.log('======================');

  /* DESERIALIZATION */
  const { metadataRpc: _, ...deserialized } = decode(serialized, { metadataRpc, registry });

  console.log('======================');
  console.log('deserialized:', JSON.stringify(deserialized, null, 2));  
  console.log('======================');

  return serialized;
}

/**
 * Utility method to submit a serialized transaction via RPC. Prints out the hash if successful
 */
async function submitTx(tx) {    
  const hash = await makeRpcCall('author_submitExtrinsic', [tx]);

  // we wait 6 seconds for finalization
  await new Promise((resolve) => {
    setTimeout(resolve, 6000);
  });

  console.log('======================');
  if (hash) {
    console.log('SUBMITTED SUCCESSFULLY');
  }
  console.log('payload:', tx);
  console.log('txHash:', hash);
  console.log('======================');
}

let polkadotApi;

async function getPolkadotApi() {
  if (!polkadotApi) {
    polkadotApi = await ApiPromise.create({
      provider: new WsProvider(NODE_URL),
      types,
      rpc,
    });
  }

  return polkadotApi;
}

/*
 * IN THIS SECTION WE ADD ALL THE NECESSARY POLYMESH CUSTOM METHODS
 */
methods.identity = {
  ...methods.identity,
  addClaim(args, info, options) {
    return defineMethod({
      method: {
        args,
        name: 'addClaim',
        pallet: 'identity'
      },
      ...info,
    },
    options)
  },
  addAuthorization(args, info, options) {
    return defineMethod({
      method: {
        args,
        name: 'addAuthorization',
        pallet: 'identity'
      },
      ...info,
    },
    options)
  },
  joinIdentityAsKey(args, info, options) {
    return defineMethod({
      method: {
        args,
        name: 'joinIdentityAsKey',
        pallet: 'identity'
      },
      ...info,
    },
    options)
  },
  cddRegisterDid(args, info, options) {
    return defineMethod({
      method: {
        args,
        name: 'cddRegisterDid',
        pallet: 'identity'
      },
      ...info,
    },
    options)
  },
}

methods.balances = {
  ...methods.balances,
  transferWithMemo(args, info, options) {
    return defineMethod({
      method: {
        args,
        name: 'transferWithMemo',
        pallet: 'balances'
      },
      ...info,
    },
    options)
  }
};
/*
 * END SECTION
 */

module.exports = {
  submitTx,
  constructSerializedTx,
  getPolkadotApi,
  getKeyPair,
  methods,
};