const anchor = require("@project-serum/anchor");
const assert = require("assert");

describe("multisig", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.getProvider();
  anchor.setProvider(provider);
  const program = anchor.workspace.SerumMultisig;

  const slotPerEpoch = async () => {
    const epochInfo = await provider.connection.getEpochInfo();
    return epochInfo.slotsInEpoch;
  };
  const sleepForAnEpoch = async () => {
    const slot = await slotPerEpoch();
    const ms = slot * 500; // 500ms per slot
    return new Promise((resolve) => setTimeout(resolve, ms));
  };

  it("Tests the multisig program", async () => {
    const multisig = anchor.web3.Keypair.generate();
    const [multisigSigner, nonce] =
      await anchor.web3.PublicKey.findProgramAddress(
        [multisig.publicKey.toBuffer()],
        program.programId
      );
    const multisigSize = 200; // Big enough.

    const ownerA = anchor.web3.Keypair.generate();
    const ownerB = anchor.web3.Keypair.generate();
    const ownerC = anchor.web3.Keypair.generate();
    const ownerD = anchor.web3.Keypair.generate();
    const owners = [ownerA.publicKey, ownerB.publicKey, ownerC.publicKey];

    const threshold = new anchor.BN(2);
    await program.rpc.createMultisig(owners, threshold, nonce, {
      accounts: {
        multisig: multisig.publicKey,
      },
      instructions: [
        await program.account.multisig.createInstruction(
          multisig,
          multisigSize
        ),
      ],
      signers: [multisig],
    });

    let multisigAccount = await program.account.multisig.fetch(
      multisig.publicKey
    );
    assert.strictEqual(multisigAccount.nonce, nonce);
    assert.ok(multisigAccount.threshold.eq(new anchor.BN(2)));
    assert.deepStrictEqual(multisigAccount.owners, owners);
    assert.ok(multisigAccount.ownerSetSeqno === 0);

    const pid = program.programId;
    const accounts = [
      {
        pubkey: multisig.publicKey,
        isWritable: true,
        isSigner: false,
      },
      {
        pubkey: multisigSigner,
        isWritable: false,
        isSigner: true,
      },
    ];
    const newOwners = [ownerA.publicKey, ownerB.publicKey, ownerD.publicKey];
    const data = program.coder.instruction.encode("set_owners", {
      owners: newOwners,
    });

    const successor = anchor.web3.Keypair.generate();
    const transaction = anchor.web3.Keypair.generate();
    const txSize = 1000; // Big enough, cuz I'm lazy.
    const ttl = new anchor.BN(1); // number of epoch
    await program.rpc.createTransaction(pid, accounts, data, successor.publicKey, ttl, {
      accounts: {
        multisig: multisig.publicKey,
        transaction: transaction.publicKey,
        proposer: ownerA.publicKey,
        sysvarClock: anchor.web3.SYSVAR_CLOCK_PUBKEY
      },
      instructions: [
        await program.account.transaction.createInstruction(
          transaction,
          txSize
        ),
      ],
      signers: [transaction, ownerA],
    });

    const txAccount = await program.account.transaction.fetch(
      transaction.publicKey
    );

    assert.ok(txAccount.programId.equals(pid));
    assert.deepStrictEqual(txAccount.accounts, accounts);
    assert.deepStrictEqual(txAccount.data, data);
    assert.ok(txAccount.multisig.equals(multisig.publicKey));
    assert.deepStrictEqual(txAccount.didExecute, false);
    assert.ok(txAccount.ownerSetSeqno === 0);
    assert.ok(txAccount.expiredEpoch.gt(ttl));
    assert.ok(txAccount.createdSlot.gtn(0));
    assert.ok(txAccount.successor.equals(successor.publicKey));

    // Other owner approves transactoin.
    await program.rpc.approve({
      accounts: {
        multisig: multisig.publicKey,
        transaction: transaction.publicKey,
        owner: ownerB.publicKey,
      },
      signers: [ownerB],
    });

    // Now that we've reached the threshold, send the transactoin.
    await program.rpc.executeTransaction({
      accounts: {
        multisig: multisig.publicKey,
        multisigSigner,
        transaction: transaction.publicKey,
      },
      remainingAccounts: program.instruction.setOwners
        .accounts({
          multisig: multisig.publicKey,
          multisigSigner,
        })
        // Change the signer status on the vendor signer since it's signed by the program, not the client.
        .map((meta) =>
          meta.pubkey.equals(multisigSigner)
            ? { ...meta, isSigner: false }
            : meta
        )
        .concat({
          pubkey: program.programId,
          isWritable: false,
          isSigner: false,
        }),
    });

    multisigAccount = await program.account.multisig.fetch(multisig.publicKey);

    assert.strictEqual(multisigAccount.nonce, nonce);
    assert.ok(multisigAccount.threshold.eq(new anchor.BN(2)));
    assert.deepStrictEqual(multisigAccount.owners, newOwners);
    assert.ok(multisigAccount.ownerSetSeqno === 1);

    await program.rpc.dropTransaction({
      accounts: {
        transaction: transaction.publicKey,
        successor: successor.publicKey,
        sysvarClock: anchor.web3.SYSVAR_CLOCK_PUBKEY
      },
    });

    try {
        transactionAccount = await program.account.transaction.fetch(transaction.publicKey);
        assert.fail();
    } catch (err) {
        assert.ok(err.message.includes("Account does not exist"));
    }
  });

  it("Assert Unique Owners", async () => {
    const multisig = anchor.web3.Keypair.generate();
    const [_multisigSigner, nonce] =
      await anchor.web3.PublicKey.findProgramAddress(
        [multisig.publicKey.toBuffer()],
        program.programId
      );
    const multisigSize = 200; // Big enough.

    const ownerA = anchor.web3.Keypair.generate();
    const ownerB = anchor.web3.Keypair.generate();
    const owners = [ownerA.publicKey, ownerB.publicKey, ownerA.publicKey];

    const threshold = new anchor.BN(2);
    try {
      await program.rpc.createMultisig(owners, threshold, nonce, {
        accounts: {
          multisig: multisig.publicKey,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        },
        instructions: [
          await program.account.multisig.createInstruction(
            multisig,
            multisigSize
          ),
        ],
        signers: [multisig],
      });
      assert.fail();
    } catch (err) {
      const error = err.error;
      assert.strictEqual(error.errorCode.number, 6008);
      assert.strictEqual(error.errorMessage, "Owners must be unique");
    }
  });

  it("Transaction should be able be dropped when ttl is expired", async () => {
    const multisig = anchor.web3.Keypair.generate();
    const [multisigSigner, nonce] =
      await anchor.web3.PublicKey.findProgramAddress(
        [multisig.publicKey.toBuffer()],
        program.programId
      );
    const multisigSize = 200; // Big enough.

    const ownerA = anchor.web3.Keypair.generate();
    const owners = [ownerA.publicKey];

    const threshold = new anchor.BN(1);
    await program.rpc.createMultisig(owners, threshold, nonce, {
      accounts: {
        multisig: multisig.publicKey,
      },
      instructions: [
        await program.account.multisig.createInstruction(
          multisig,
          multisigSize
        ),
      ],
      signers: [multisig],
    });

    const pid = program.programId;
    const accounts = [
      {
        pubkey: multisig.publicKey,
        isWritable: true,
        isSigner: false,
      },
      {
        pubkey: multisigSigner,
        isWritable: false,
        isSigner: true,
      },
    ];
    const newOwners = [ownerA.publicKey];
    const data = program.coder.instruction.encode("set_owners", {
      owners: newOwners,
    });

    const transaction = anchor.web3.Keypair.generate();
    const successor = anchor.web3.Keypair.generate();
    const txSize = 1000; // Big enough, cuz I'm lazy.
    const ttl = new anchor.BN(1); // number of epoch
    await program.rpc.createTransaction(pid, accounts, data, successor.publicKey, ttl, {
      accounts: {
        multisig: multisig.publicKey,
        transaction: transaction.publicKey,
        proposer: ownerA.publicKey,
        sysvarClock: anchor.web3.SYSVAR_CLOCK_PUBKEY
      },
      instructions: [
        await program.account.transaction.createInstruction(
          transaction,
          txSize
        ),
      ],
      signers: [transaction, ownerA],
    });

    await sleepForAnEpoch();

    await program.rpc.dropTransaction({
      accounts: {
        transaction: transaction.publicKey,
        successor: successor.publicKey,
        sysvarClock: anchor.web3.SYSVAR_CLOCK_PUBKEY
      },
    });

    try {
        transactionAccount = await program.account.transaction.fetch(transaction.publicKey);
        assert.fail();
    } catch (err) {
        assert.ok(err.message.includes("Account does not exist"));
    }
    const successorAccBalance = await program.provider.connection.getBalance(successor.publicKey);
    assert.ok(successorAccBalance > 0);
  });
});
