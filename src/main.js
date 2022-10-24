const onchain = require('./onchain');
const offchain = require('./offchain');
const { submitTx, getKeyPair, listenForInclusion } = require('./utils');

const main = async () => {
  // Private key of the primary key of the identity you wish to join.
  const primaryPrivateKey = '0x6d7cf82b7b91ae55fc5b16aa43788889fb3efb872662078202fdb2394a35c200';
  // Private key of the secondary key joining the identity.
  const secondaryPrivateKey = '0x18b2d6a2d3139afef52ef3a05e8ced63f5d6ac8e6606ad63be7e482fe6434a4f';
  // get public addresses
  const { address: primaryAddress } = await getKeyPair(primaryPrivateKey);
  const { address: secondaryAddress } = await getKeyPair(secondaryPrivateKey);

  console.log(`Attempting to join secondary key :`, secondaryAddress);
  console.log(`To the identity of primary key :`, primaryAddress);

  // check the primary key has valid permissions
  const primaryIdStatus = await onchain.getIdentityStatus(primaryAddress);
  if (!primaryIdStatus.did || !primaryIdStatus.hasCddClaim || !primaryIdStatus.isPrimaryKey) {
    console.log('The provided primary key is not a valid primary key');
    return;
  }

  // check the secondary key is not already attached to an identity
  let secondaryIdStatus = await onchain.getIdentityStatus(secondaryAddress);
  if (secondaryIdStatus.did) {
    console.log('Secondary key is already attached to an identity');
    return;
  }

  // create and sign the transaction
  const addSecondaryKeyTx = await offchain.addSecondaryKey(primaryPrivateKey, secondaryAddress);
  // submit the transaction to the chain
  addSecondaryExtrinsicHash = await submitTx(addSecondaryKeyTx);
  if (!addSecondaryExtrinsicHash) {
    console.log('Submit transaction failed');
    return;
  }
  // monitor for inclusion on chain
  const addAuthorizationResult = await listenForInclusion(addSecondaryExtrinsicHash);
  if (!addAuthorizationResult.success) {
    console.log('Add Authorization transaction failed');
    return;
  }
  // get array of pending authorizations
  const pendingAuths = await onchain.getPendingAuthorizations(secondaryAddress);
  if (pendingAuths.length === 0) {
    console.log('No pending authorizations of type JoinIdentity');
    return;
  }

  // sort so we are approving the most recent authorization.
  pendingAuths.sort((a, b) => a - b);

  // create and sign the transaction
  const joinIdentityTx = await offchain.joinIdentity(secondaryPrivateKey, pendingAuths[pendingAuths.length - 1]);
  // submit the transaction to the chain
  const joinIdentityExtrinsicHash = await submitTx(joinIdentityTx);
  if (!joinIdentityExtrinsicHash) {
    console.log('Submit transaction failed');
    return;
  }
  // monitor for inclusion on chain
  const joinIdentityResult = await listenForInclusion(joinIdentityExtrinsicHash);
  if (!joinIdentityResult.success) {
    console.log('Join Identity transaction failed');
    return;
  }

  // Confirm secondary key now is associated with the primary key's identity
  secondaryIdStatus = await onchain.getIdentityStatus(secondaryAddress);

  if (!secondaryIdStatus.did) {
    console.log('Secondary key failed to join the primary key');
    return;
  }
  if (secondaryIdStatus.did.toString() === primaryIdStatus.did.toString()) {
    console.log('SECONDARY KEY ADDED SUCCESSFULLY');
    return;
  }
  console.log('!!!ATTENTION: Secondary key has joined the incorrect identity!!!');
};

main()
  .catch(console.error)
  .finally(() => process.exit());
