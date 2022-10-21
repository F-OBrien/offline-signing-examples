const onchain = require('./onchain');
const offchain = require('./offchain');
const { submitTx, getKeyPair } = require('./utils');

const main = async () => {
  // Private key of the primary key of the identity you wish to join.
  const primaryPrivateKey = '0x6d7cf82b7b91ae55fc5b16aa43788889fb3efb872662078202fdb2394a35c200';
  // Private key of the secondary key joining the identity.
  const secondaryPrivateKey = '0x18b2d6a2d3139afef52ef3a05e8ced63f5d6ac8e6606ad63be7e482fe6434a4f';

  const { address: primaryAddress } = await getKeyPair(primaryPrivateKey);
  const { address: secondaryAddress } = await getKeyPair(secondaryPrivateKey);
  console.log(`Attempting to join secondary key :`, secondaryAddress);
  console.log(`To the identity of primary key :`, primaryAddress);

  const primaryIdStatus = await onchain.getIdentityStatus(primaryAddress);

  if (!primaryIdStatus.did || !primaryIdStatus.hasCddClaim || !primaryIdStatus.isPrimaryKey) {
    console.log('The provided primary key is not a valid primary key');
    return;
  }

  let secondaryIdStatus = await onchain.getIdentityStatus(secondaryAddress);

  if (secondaryIdStatus.did) {
    console.log('Secondary key is already attached to an identity');
    return;
  }

  const addSecondaryKeyTx = await offchain.addSecondaryKey(primaryPrivateKey, secondaryAddress);

  await submitTx(addSecondaryKeyTx);

  const pendingAuths = await onchain.getPendingAuthorizations(secondaryAddress);
  if (pendingAuths.length === 0) {
    console.log('No pending authorizations of type JoinIdentity');
    return;
  }

  // Sort so we only approve the most recent authorization.
  pendingAuths.sort((a, b) => a - b);

  const joinIdentityTx = await offchain.joinIdentity(secondaryPrivateKey, pendingAuths[pendingAuths.length - 1]);

  await submitTx(joinIdentityTx);

  // Confirm secondary key now is associated with the primary key's identity
  secondaryIdStatus = await onchain.getIdentityStatus(secondaryAddress);
  if (!secondaryIdStatus.did) {
    console.log('Secondary key failed to join the primary key');
    return;
  }
  if (secondaryIdStatus.did.toString() != primaryIdStatus.did.toString()) {
    console.log('!!!ATTENTION: Secondary key has joined the incorrect identity!!!');
    return;
  }
  console.log('***SECONDARY KEY ADDED SUCCESSFULLY***');
};

main()
  .catch(console.error)
  .finally(() => process.exit());
