import { IClientConfig } from "../interfaces/IClientConfig";
import { IAccount } from "../interfaces/IAccount";
import * as secp from "@noble/secp256k1";
import { BaseClient } from "./BaseClient";
import { IAddressInfo } from "../interfaces/IAddressInfo";
import { IFullAddressInfo } from "../interfaces/IFullAddressInfo";
import { ISignature } from "../interfaces/ISignature";
import { base58Decode, base58Encode, varintEncode, hashBlake3 } from "../utils/Xbqcrypto";
import { JSON_RPC_REQUEST_METHOD } from "../interfaces/JsonRpcMethods";
import { trySafeExecute } from "../utils/retryExecuteFunction";
import { ITransactionData } from "../interfaces/ITransactionData";
import { OperationTypeId } from "../interfaces/OperationTypes";
import { PublicApiClient } from "./PublicApiClient";
import { IRollsData } from "../interfaces/IRollsData";
import { INodeStatus } from "../interfaces/INodeStatus";
import { IBalance } from "../interfaces/IBalance";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { schnorr } from "@noble/secp256k1";
import { IWalletClient } from "../interfaces/IWalletClient";
import * as createhash from "create-hash";

const VERSION_NUMBER: number = 0;
const ADDRESS_PRAEFIX = "A";
const MAX_WALLET_ACCOUNTS: number = 256;

// add hmacSync for sync signing
secp.utils.hmacSha256Sync = (key: Uint8Array, ...msgs: Uint8Array[]): Uint8Array => {
  const h = hmac.create(sha256, key);
  msgs.forEach(msg => h.update(msg));
  return h.digest();
};

secp.utils.sha256Sync = (...msgs: Uint8Array[]): Uint8Array => {
	const h = createhash("sha256");
	msgs.forEach(msg => h.update(msg));
	return h.digest();
};

/** Wallet module that will under the hood interact with WebExtension, native client or interactively with user */
export class WalletClient extends BaseClient implements IWalletClient {

	private wallet: Array<IAccount> = [];
	private baseAccount: IAccount;

	public constructor(clientConfig: IClientConfig, private readonly publicApiClient: PublicApiClient, baseAccount?: IAccount) {
		super(clientConfig);

		// ========== bind wallet methods ========= //

		// wallet methods
		this.cleanWallet = this.cleanWallet.bind(this);
		this.getWalletAccounts = this.getWalletAccounts.bind(this);
		this.getWalletAccountByAddress = this.getWalletAccountByAddress.bind(this);
		this.addPrivateKeysToWallet = this.addPrivateKeysToWallet.bind(this);
		this.addAccountsToWallet = this.addAccountsToWallet.bind(this);
		this.removeAddressesFromWallet = this.removeAddressesFromWallet.bind(this);
		this.walletInfo = this.walletInfo.bind(this);
		this.signMessage = this.signMessage.bind(this);
		this.getWalletAddressesInfo = this.getWalletAddressesInfo.bind(this);
		this.setBaseAccount = this.setBaseAccount.bind(this);
		this.getBaseAccount = this.getBaseAccount.bind(this);
		this.sendTransaction = this.sendTransaction.bind(this);
		this.sellRolls = this.sellRolls.bind(this);
		this.buyRolls = this.buyRolls.bind(this);
		this.getAccountSequentialBalance = this.getAccountSequentialBalance.bind(this);

		// init wallet with a base account if any
		if (baseAccount) {
			this.setBaseAccount(baseAccount);
		}
	}

	/** set the default (base) account */
	public setBaseAccount(baseAccount: IAccount): void {
		// see if base account is already added, if not, add it
		let baseAccountAdded: Array<IAccount> = null;
		if (!this.getWalletAccountByAddress(baseAccount.address)) {
			baseAccountAdded = this.addAccountsToWallet([baseAccount]);
			this.baseAccount = baseAccountAdded[0];
		} else {
			this.baseAccount = baseAccount;
		}
	}

	/** get the default (base) account */
	public getBaseAccount(): IAccount {
		return this.baseAccount;
	}

	/** get all accounts under a wallet */
	public getWalletAccounts(): Array<IAccount> {
		return this.wallet;
	}

	/** delete all accounts under a wallet */
	public cleanWallet(): void {
		this.wallet.length = 0;
	}

	/** get wallet account by an address */
	public getWalletAccountByAddress(address: string): IAccount | undefined {
		return this.wallet.find((w) => w.address.toLowerCase() === address.toLowerCase()); // ignore case for flexibility
	}

	/** add a list of private keys to the wallet */
	public addPrivateKeysToWallet(privateKeys: Array<string>): Array<IAccount> {
		if (privateKeys.length > MAX_WALLET_ACCOUNTS) {
			throw new Error(`Maximum number of allowed wallet accounts exceeded ${MAX_WALLET_ACCOUNTS}. Submitted private keys: ${privateKeys.length}`);
		}
		const accountsToCreate = new Array<IAccount>();

		for (const privateKey of privateKeys) {
			const privateKeyBase58Decoded: Buffer = base58Decode(privateKey);
			const publicKey: Uint8Array = secp.schnorr.getPublicKey(privateKeyBase58Decoded);
			const publicKeyBase58Encoded: string = base58Encode(publicKey);

			const version = Buffer.from(varintEncode(VERSION_NUMBER));
			const addressBase58Encoded = ADDRESS_PRAEFIX + base58Encode(Buffer.concat([version, hashBlake3(publicKey)]));

			if (!this.getWalletAccountByAddress(addressBase58Encoded)) {
				accountsToCreate.push({
					privateKey: privateKey, // submitted in base58
					publicKey: publicKeyBase58Encoded,
					address: addressBase58Encoded,
					randomEntropy: null
				} as IAccount);
			}
		}

		this.wallet.push(...accountsToCreate);
		return accountsToCreate;
	}

	/** add accounts to wallet. Prerequisite: each account must have a base58 encoded random entropy or private key */
	public addAccountsToWallet(accounts: Array<IAccount>): Array<IAccount> {
		if (accounts.length > MAX_WALLET_ACCOUNTS) {
			throw new Error(`Maximum number of allowed wallet accounts exceeded ${MAX_WALLET_ACCOUNTS}. Submitted accounts: ${accounts.length}`);
		}
		const accountsAdded: Array<IAccount> = [];

		for (const account of accounts) {
			if (!account.randomEntropy && !account.privateKey) {
				throw new Error("Missing account entropy / private key");
			}

			let privateKeyBase58Encoded: string = null;

			// account is specified via entropy
			if (account.randomEntropy) {
				const base58DecodedRandomEntropy: Buffer = base58Decode(account.randomEntropy);
				const privateKey: Uint8Array = secp.utils.hashToPrivateKey(base58DecodedRandomEntropy);
				privateKeyBase58Encoded = base58Encode(privateKey);
			}

			// if not entropy defined, use the base58 encoded value defined as param
			privateKeyBase58Encoded = privateKeyBase58Encoded || account.privateKey;

			// get public key
			const publicKey: Uint8Array = secp.schnorr.getPublicKey(base58Decode(privateKeyBase58Encoded));
			const publicKeyBase58Encoded: string = base58Encode(publicKey);

			if (account.publicKey && account.publicKey !== publicKeyBase58Encoded) {
				throw new Error("Public key does not correspond the the private key submitted");
			}

			// get wallet account address
			const version = Buffer.from(varintEncode(VERSION_NUMBER));
			const addressBase58Encoded = ADDRESS_PRAEFIX + base58Encode(Buffer.concat([version, hashBlake3(publicKey)]));
			if (account.address && account.address !== addressBase58Encoded) {
				throw new Error("Account address not correspond the the address submitted");
			}

			if (!this.getWalletAccountByAddress(addressBase58Encoded)) {
				accountsAdded.push({
					address: addressBase58Encoded,
					privateKey: privateKeyBase58Encoded,
					publicKey: publicKeyBase58Encoded,
					randomEntropy: account.randomEntropy
				} as IAccount);
			}
		}

		this.wallet.push(...accountsAdded);
		return accountsAdded;
	}

	/** remove a list of addresses from the wallet */
	public removeAddressesFromWallet(addresses: Array<string>): void {
		for (const address of addresses) {
			const index = this.wallet.findIndex((w) => w.address === address);
			if (index > -1) {
				this.wallet.splice(index, 1);
			}
		}
	}

	/** show wallet info (private keys, public keys, addresses, balances ...) */
	public async walletInfo(): Promise<Array<IFullAddressInfo>> {
		if (this.wallet.length === 0) {
			return [];
		}
		const addresses: Array<string> = this.wallet.map((account) => account.address);
		const addressesInfo: Array<IAddressInfo> = await this.getWalletAddressesInfo(addresses);

		if (addressesInfo.length !== this.wallet.length) {
			throw new Error(`Requested wallets not fully retrieved. Got ${addressesInfo.length}, expected: ${this.wallet.length}`);
		}

		return addressesInfo.map((info, index) => {
			return {
				publicKey: this.wallet[index].publicKey,
				privateKey: this.wallet[index].privateKey,
				randomEntropy: this.wallet[index].randomEntropy,
				...info
			} as IFullAddressInfo;
		});
	}

	 /** generate a new account */
	public static walletGenerateNewAccount(): IAccount {

		// generate private key
		const randomBytes: Uint8Array = secp.utils.randomBytes(32);
		const privateKey: Uint8Array = secp.utils.hashToPrivateKey(randomBytes);
		const privateKeyBase58Encoded: string = base58Encode(privateKey);

		// get public key
		const publicKey: Uint8Array = secp.schnorr.getPublicKey(privateKey);
		const publicKeyBase58Encoded: string = base58Encode(publicKey);

		// get wallet account address
		const version = Buffer.from(varintEncode(VERSION_NUMBER));
		const addressBase58Encoded = ADDRESS_PRAEFIX + base58Encode(Buffer.concat([version, hashBlake3(publicKey)]));

		return {
			address: addressBase58Encoded,
			privateKey: privateKeyBase58Encoded,
			publicKey: publicKeyBase58Encoded,
			randomEntropy: base58Encode(randomBytes)
		} as IAccount;
	}

	/** returns an account from private key */
	public static getAccountFromPrivateKey(privateKeyBase58: string): IAccount {
		// get private key
		const privateKeyBase58Decoded: Buffer = base58Decode(privateKeyBase58);

		// get public key
		const publicKey: Uint8Array = secp.schnorr.getPublicKey(privateKeyBase58Decoded);
		const publicKeyBase58Encoded: string = base58Encode(publicKey);

		// get wallet account address
		const version = Buffer.from(varintEncode(VERSION_NUMBER));
		const addressBase58Encoded = ADDRESS_PRAEFIX + base58Encode(Buffer.concat([version, hashBlake3(publicKey)]));

		return {
			address: addressBase58Encoded,
			privateKey: privateKeyBase58,
			publicKey: publicKeyBase58Encoded,
			randomEntropy: null
		} as IAccount;
	}

	/** returns an account from entropy */
	public static getAccountFromEntropy(entropyBase58: string): IAccount {
		// decode entropy
		const entropyBase58Decoded: Buffer = base58Decode(entropyBase58);

		// get private key
		const privateKey: Uint8Array = secp.utils.hashToPrivateKey(entropyBase58Decoded);
		const privateKeyBase58Encoded: string = base58Encode(privateKey);

		// get public key
		const publicKey: Uint8Array = secp.schnorr.getPublicKey(privateKey);
		const publicKeyBase58Encoded: string = base58Encode(publicKey);

		// get wallet account address
		const version = Buffer.from(varintEncode(VERSION_NUMBER));
		const addressBase58Encoded = ADDRESS_PRAEFIX + base58Encode(Buffer.concat([version, hashBlake3(publicKey)]));

		return {
			address: addressBase58Encoded,
			privateKey: privateKeyBase58Encoded,
			publicKey: publicKeyBase58Encoded,
			randomEntropy: entropyBase58
		} as IAccount;
	}

	/** sign random message data with an already added wallet account */
	public signMessage(data: string | Buffer, accountSignerAddress: string): ISignature {
		const signerAccount = this.getWalletAccountByAddress(accountSignerAddress);
		if (!signerAccount) {
			throw new Error(`No signer account ${accountSignerAddress} found in wallet`);
		}
		return WalletClient.walletSignMessage(data, signerAccount);
	}

	/** get wallet addresses info */
	private async getWalletAddressesInfo(addresses: Array<string>): Promise<Array<IAddressInfo>> {
		const jsonRpcRequestMethod = JSON_RPC_REQUEST_METHOD.GET_ADDRESSES;
		if (this.clientConfig.retryStrategyOn) {
			return await trySafeExecute<Array<IAddressInfo>>(this.sendJsonRPCRequest, [jsonRpcRequestMethod, [addresses]]);
		} else {
			return await this.sendJsonRPCRequest<Array<IAddressInfo>>(jsonRpcRequestMethod, [addresses]);
		}
	}

	/** sign provided string with given address (address must be in the wallet) */
	public static walletSignMessage(data: string | Buffer, signer: IAccount): ISignature {

		// check private keys to sign the message with
		if (!signer.privateKey) {
			throw new Error("No private key to sign the message with");
		}

		// check public key to verify the message with
		if (!signer.publicKey) {
			throw new Error("No public key to verify the signed message with");
		}

    	// cast private key
		const privateKeyBase58Decoded = base58Decode(signer.privateKey);

		// bytes compaction
		const bytesCompact: Buffer = Buffer.from(data);
		// Hash byte compact
		const messageHashDigest: Uint8Array = hashBlake3(bytesCompact);

		// sign the digest
		const sig = schnorr.signSync(messageHashDigest, privateKeyBase58Decoded);

		// check sig length
		if (sig.length != 64) {
			throw new Error(`Invalid signature length. Expected 64, got ${sig.length}`);
		}

		// verify signature
		if (signer.publicKey) {
			const publicKeyBase58Decoded = base58Decode(signer.publicKey);
			const isVerified = schnorr.verifySync(sig, messageHashDigest, publicKeyBase58Decoded);
			if (!isVerified) {
				throw new Error(`Signature could not be verified with public key. Please inspect`);
			}
		}

		// convert sig
		const hex = secp.utils.bytesToHex(sig);
		const base58Encoded = base58Encode(sig);

		return {
			hex,
			base58Encoded
		} as ISignature;
	}

	/** Returns the account sequential balance - the consensus side balance  */
	public async getAccountSequentialBalance(address: string): Promise<IBalance | null> {
		const addresses: Array<IAddressInfo> = await this.publicApiClient.getAddresses([address]);
		if (addresses.length === 0) return null;
		const addressInfo: IAddressInfo = addresses.at(0);
		return {
			candidate: addressInfo.ledger_info.candidate_ledger_info.balance,
			final: addressInfo.ledger_info.final_ledger_info.balance
		} as IBalance;
	}

	/** send native MAS from a wallet address to another */
	public async sendTransaction(txData: ITransactionData, executor?: IAccount): Promise<Array<string>> {

		// check sender account
		const sender: IAccount = executor || this.getBaseAccount();
		if (!sender) {
			throw new Error(`No tx sender available`);
		}

		// get next period info
		const nodeStatusInfo: INodeStatus = await this.publicApiClient.getNodeStatus();
		const expiryPeriod: number = nodeStatusInfo.next_slot.period + this.clientConfig.periodOffset;

		// bytes compaction
		const bytesCompact: Buffer = this.compactBytesForOperation(txData, OperationTypeId.Transaction, sender, expiryPeriod);

		// sign payload
		const signature: ISignature = WalletClient.walletSignMessage(bytesCompact, sender);

		// prepare tx data
		const data = {
			content: {
				expire_period: expiryPeriod,
				fee: txData.fee.toString(),
				op: {
					Transaction: {
						amount: txData.amount.toString(),
						recipient_address: txData.recipientAddress
					}
				},
				creator_public_key: sender.publicKey
			},
			signature: signature.base58Encoded,
		};
		// returns operation ids
		const opIds: Array<string> = await this.sendJsonRPCRequest(JSON_RPC_REQUEST_METHOD.SEND_OPERATIONS, [[data]]);
		return opIds;
	}

	/** buy rolls with wallet address */
	public async buyRolls(txData: IRollsData, executor?: IAccount): Promise<Array<string>> {

		// check sender account
		const sender: IAccount = executor || this.getBaseAccount();
		if (!sender) {
			throw new Error(`No tx sender available`);
		}

		// get next period info
		const nodeStatusInfo: INodeStatus = await this.publicApiClient.getNodeStatus();
		const expiryPeriod: number = nodeStatusInfo.next_slot.period + this.clientConfig.periodOffset;

		// bytes compaction
		const bytesCompact: Buffer = this.compactBytesForOperation(txData, OperationTypeId.RollBuy, sender, expiryPeriod);

		// sign payload
		const signature: ISignature = WalletClient.walletSignMessage(bytesCompact, sender);

		const data = {
			content: {
				expire_period: expiryPeriod,
				fee: txData.fee.toString(),
				op: {
					RollBuy: {
						roll_count: txData.amount,
					}
				},
				creator_public_key: sender.publicKey
			},
			signature: signature.base58Encoded,
		};
		// returns operation ids
		const opIds: Array<string> = await this.sendJsonRPCRequest(JSON_RPC_REQUEST_METHOD.SEND_OPERATIONS, [[data]]);
		return opIds;
	}

	/** sell rolls with wallet address */
	public async sellRolls(txData: IRollsData, executor?: IAccount): Promise<Array<string>> {

		// check sender account
		const sender: IAccount = executor || this.getBaseAccount();
		if (!sender) {
			throw new Error(`No tx sender available`);
		}

		// get next period info
		const nodeStatusInfo: INodeStatus = await this.publicApiClient.getNodeStatus();
		const expiryPeriod: number = nodeStatusInfo.next_slot.period + this.clientConfig.periodOffset;

		// bytes compaction
		const bytesCompact: Buffer = this.compactBytesForOperation(txData, OperationTypeId.RollSell, sender, expiryPeriod);

		// sign payload
		const signature: ISignature = WalletClient.walletSignMessage(bytesCompact, sender);

		const data = {
			content: {
				expire_period: expiryPeriod,
				fee: txData.fee.toString(),
				op: {
					RollSell: {
						roll_count: txData.amount,
					}
				},
				creator_public_key: sender.publicKey
			},
			signature: signature.base58Encoded,
		};
		// returns operation ids
		const opIds: Array<string> = await this.sendJsonRPCRequest(JSON_RPC_REQUEST_METHOD.SEND_OPERATIONS, [[data]]);
		return opIds;
	}
}
