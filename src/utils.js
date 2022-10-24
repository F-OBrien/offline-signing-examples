const Client = require('rpc-websockets').Client;
const { methods, TypeRegistry, decode, construct, getRegistryBase, getSpecTypes, defineMethod } = require('@substrate/txwrapper-polkadot');
const { Keyring, ApiPromise, WsProvider } = require('@polkadot/api');
const { hexToU8a } = require('@polkadot/util');
const { cryptoWaitReady } = require('@polkadot/util-crypto');
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
      });
    });
  }

  return wsClient;
}

/**
 * internal, ignore this
 */
async function makeRpcCall(method, params = []) {
  const client = await getClient();
  const res = await client.call(method, params).catch((err) => console.error(err));
  return res;
}

/**
 * Get all the necessary data to build a transaction. You can replace this with your specific internal API
 *
 * @param {string} callingAddress - address that will sign the transaction
 *
 * @returns current block data, chain spec, registry, nonce, etc
 */
async function getTxData(callingAddress) {
  const [{ block }, blockHash, genesisHash, metadataRpc, nonce, { specVersion, transactionVersion, specName }] = await Promise.all([
    makeRpcCall('chain_getBlock'),
    makeRpcCall('chain_getBlockHash'),
    makeRpcCall('chain_getBlockHash', [0]),
    makeRpcCall('state_getMetadata'),
    makeRpcCall('system_accountNextIndex', [callingAddress]),
    makeRpcCall('state_getRuntimeVersion'),
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
    metadataRpc,
  });

  const blockNumber = registryBase.createType('BlockNumber', block.header.number).toNumber();

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
  return (keyPair = keyring.addFromSeed(seed));
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
  const { blockHash, blockNumber, genesisHash, metadataRpc, nonce, specVersion, transactionVersion, eraPeriod, tip, registry } = await getTxData(
    address
  );

  const unsignedTx = method(
    methodArgs,
    {
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
    },
    {
      metadataRpc,
      registry,
    }
  );

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

  console.log('======================');
  if (hash) {
    console.log('SUBMITTED SUCCESSFULLY');
    console.log('txHash:', hash);
  }
  console.log('payload:', tx);
  console.log('======================');
  return hash;
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

async function listenForInclusion(extrinsicHash) {
  const api = await getPolkadotApi();
  console.log('Listening for transaction hash', extrinsicHash);
  let isOnChain = false;
  let success = false;

  // Note: `subscribeNewHeads` can be replaced with `subscribeFinalizedHeads` to only watch finalized blocks
  const unsub = await api.rpc.chain.subscribeNewHeads(async (header) => {
    const blockNumber = header.number.toNumber();
    const blockHash = await api.rpc.chain.getBlockHash(blockNumber);
    const signedBlock = await api.rpc.chain.getBlock(blockHash);

    // check if the transaction hash was included in the block.
    const extrinsicIndex = signedBlock.block.extrinsics.findIndex(({ hash }) => hash.toString() === extrinsicHash);

    if (extrinsicIndex >= 0) {
      // get the api and events at a specific block
      const apiAt = await api.at(blockHash);
      const allRecords = await apiAt.query.system.events();

      extrinsic = signedBlock.block.extrinsics[extrinsicIndex];

      const {
        method: { method, section },
      } = extrinsic;

      allRecords
        // filter the specific events based on the phase and then the
        // index of our extrinsic in the block
        .filter(({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.eq(extrinsicIndex))
        // test the events against the specific types we are looking for
        .forEach(({ event }) => {
          if (api.events.system.ExtrinsicSuccess.is(event)) {
            // extract the data for this event
            // (In TS, because of the guard above, these will be typed)
            const [dispatchInfo] = event.data;
            console.log(`${section}.${method}:: ExtrinsicSuccess:: ${JSON.stringify(dispatchInfo.toHuman())}`);
            success = true;
          } else if (api.events.system.ExtrinsicFailed.is(event)) {
            // extract the data for this event
            const [dispatchError, dispatchInfo] = event.data;
            let errorInfo;

            // decode the error
            if (dispatchError.isModule) {
              // for module errors, we have the section indexed, lookup
              // (For specific known errors, we can also do a check against the
              // api.errors.<module>.<ErrorName>.is(dispatchError.asModule) guard)
              const decoded = api.registry.findMetaError(dispatchError.asModule);

              errorInfo = `${decoded.section}.${decoded.name}`;
            } else {
              // Other, CannotLookup, BadOrigin, no extra info
              errorInfo = dispatchError.toString();
            }

            console.log(`${section}.${method}:: ExtrinsicFailed:: ${errorInfo}`);
          }
        });
      unsub();
      isOnChain = true;
    }
  });

  // We only want the function to resolve after the transaction is found onchain
  // or the timeout is exceeded
  const timeoutMs = 20000;
  await new Promise((resolve, reject) => {
    const timeWas = new Date();
    const wait = setInterval(function () {
      if (isOnChain) {
        console.log('Transaction hash found on chain');
        clearInterval(wait);
        resolve();
      } else if (new Date() - timeWas > timeoutMs) {
        // Timeout
        console.log('Timed out after', new Date() - timeWas, 'ms');
        clearInterval(wait);
        reject('The transaction hash was not found on chain before the timeout expired');
      }
    }, 1000);
  });

  return { isOnChain, success };
}

/*
 * IN THIS SECTION WE ADD ALL THE NECESSARY POLYMESH CUSTOM METHODS
 */
methods.identity = {
  ...methods.identity,
  addClaim(args, info, options) {
    return defineMethod(
      {
        method: {
          args,
          name: 'addClaim',
          pallet: 'identity',
        },
        ...info,
      },
      options
    );
  },
  addAuthorization(args, info, options) {
    return defineMethod(
      {
        method: {
          args,
          name: 'addAuthorization',
          pallet: 'identity',
        },
        ...info,
      },
      options
    );
  },
  joinIdentityAsKey(args, info, options) {
    return defineMethod(
      {
        method: {
          args,
          name: 'joinIdentityAsKey',
          pallet: 'identity',
        },
        ...info,
      },
      options
    );
  },
  cddRegisterDid(args, info, options) {
    return defineMethod(
      {
        method: {
          args,
          name: 'cddRegisterDid',
          pallet: 'identity',
        },
        ...info,
      },
      options
    );
  },
};

methods.balances = {
  ...methods.balances,
  transferWithMemo(args, info, options) {
    return defineMethod(
      {
        method: {
          args,
          name: 'transferWithMemo',
          pallet: 'balances',
        },
        ...info,
      },
      options
    );
  },
};
/*
 * END SECTION
 */

module.exports = {
  submitTx,
  constructSerializedTx,
  getPolkadotApi,
  listenForInclusion,
  getKeyPair,
  methods,
};
