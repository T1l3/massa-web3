import { EOperationStatus } from "../interfaces/EOperationStatus";
import { IAccount } from "../interfaces/IAccount";
import { IAddressInfo } from "../interfaces/IAddressInfo";
import { IBalance } from "../interfaces/IBalance";
import { ICallData } from "../interfaces/ICallData";
import { IClientConfig } from "../interfaces/IClientConfig";
import { IContractData } from "../interfaces/IContractData";
import { IContractReadOperationData } from "../interfaces/IContractReadOperationData";
import { IContractStorageData } from "../interfaces/IContractStorageData";
import { IEvent } from "../interfaces/IEvent";
import { IEventFilter } from "../interfaces/IEventFilter";
import { IExecuteReadOnlyResponse } from "../interfaces/IExecuteReadOnlyResponse";
import { INodeStatus } from "../interfaces/INodeStatus";
import { IOperationData } from "../interfaces/IOperationData";
import { IReadData } from "../interfaces/IReadData";
import { ISignature } from "../interfaces/ISignature";
import { ISmartContractsClient } from "../interfaces/ISmartContractsClient";
import { JSON_RPC_REQUEST_METHOD } from "../interfaces/JsonRpcMethods";
import { OperationTypeId } from "../interfaces/OperationTypes";
import { trySafeExecute } from "../utils/retryExecuteFunction";
import { wait } from "../utils/Wait";
import { base58Encode, hashBlake3 } from "../utils/Xbqcrypto";
import { BaseClient } from "./BaseClient";
import { PublicApiClient } from "./PublicApiClient";
import { WalletClient } from "./WalletClient";

const TX_POLL_INTERVAL_MS = 10000;
const TX_STATUS_CHECK_RETRY_COUNT = 100;

/** Smart Contracts Client which enables compilation, deployment and streaming of events */
export class SmartContractsClient extends BaseClient implements ISmartContractsClient {

	public constructor(clientConfig: IClientConfig, private readonly publicApiClient: PublicApiClient, private readonly walletClient: WalletClient) {
		super(clientConfig);

		// bind class methods
		this.deploySmartContract = this.deploySmartContract.bind(this);
		this.getFilteredScOutputEvents = this.getFilteredScOutputEvents.bind(this);
		this.executeReadOnlySmartContract = this.executeReadOnlySmartContract.bind(this);
		this.awaitRequiredOperationStatus = this.awaitRequiredOperationStatus.bind(this);
		this.getOperationStatus = this.getOperationStatus.bind(this);
		this.callSmartContract = this.callSmartContract.bind(this);
		this.readSmartContract = this.readSmartContract.bind(this);
		this.getParallelBalance = this.getParallelBalance.bind(this);
	}

	/** create and send an operation containing byte code */
	public async deploySmartContract(contractData: IContractData, executor?: IAccount): Promise<Array<string>> {
		// get next period info
		const nodeStatusInfo: INodeStatus = await this.publicApiClient.getNodeStatus();
		const expiryPeriod: number = nodeStatusInfo.next_slot.period + this.clientConfig.periodOffset;

		// get the block size
		if (contractData.contractDataBase64.length > nodeStatusInfo.config.max_block_size / 2) {
			console.warn("bytecode size exceeded half of the maximum size of a block, operation will certainly be rejected");
		}

		// check sender account
		const sender: IAccount = executor || this.walletClient.getBaseAccount();
		if (!sender) {
			throw new Error(`No tx sender available`);
		}

		// bytes compaction
		const bytesCompact: Buffer = this.compactBytesForOperation(contractData, OperationTypeId.ExecuteSC, sender, expiryPeriod);

		// sign payload
		const signature: ISignature = WalletClient.walletSignMessage(bytesCompact, sender);

		// revert base64 sc data to binary
		if (!contractData.contractDataBase64) {
			throw new Error(`Contract base64 encoded data required. Got null`);
		}
        const decodedScBinaryCode = new Uint8Array(Buffer.from(contractData.contractDataBase64, "base64"));

		const data = {
			content: {
				expire_period: expiryPeriod,
				fee: contractData.fee.toString(),
				op: {
					ExecuteSC: {
						data: Array.from(decodedScBinaryCode),
						max_gas: contractData.maxGas,
						coins: contractData.coins.toString(),
						gas_price: contractData.gasPrice.toString()
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

	/** call smart contract method */
	public async callSmartContract(callData: ICallData, executor?: IAccount): Promise<Array<string>> {
		// get next period info
		const nodeStatusInfo: INodeStatus = await this.publicApiClient.getNodeStatus();
		const expiryPeriod: number = nodeStatusInfo.next_slot.period + this.clientConfig.periodOffset;

		// check sender account
		const sender = executor || this.walletClient.getBaseAccount();
		if (!sender) {
			throw new Error(`No tx sender available`);
		}

		// bytes compaction
		const bytesCompact: Buffer = this.compactBytesForOperation(callData, OperationTypeId.CallSC, sender, expiryPeriod);

		// sign payload
		const signature: ISignature = WalletClient.walletSignMessage(bytesCompact, sender);
		// request data
		const data = {
			content: {
				expire_period: expiryPeriod,
				fee: callData.fee.toString(),
				op: {
					CallSC: {
						max_gas: callData.maxGas,
						gas_price: callData.gasPrice.toString(),
						parallel_coins: callData.parallelCoins.toString(),
						sequential_coins: callData.sequentialCoins.toString(),
						target_addr: callData.targetAddress,
						target_func: callData.functionName,
						param: callData.parameter,
					}
				},
				creator_public_key: sender.publicKey
			},
			signature: signature.base58Encoded,
		};
		// returns operation ids
		const jsonRpcRequestMethod = JSON_RPC_REQUEST_METHOD.SEND_OPERATIONS;
		if (this.clientConfig.retryStrategyOn) {
			return await trySafeExecute<Array<string>>(this.sendJsonRPCRequest, [jsonRpcRequestMethod, [[data]]]);
		} else {
			return await this.sendJsonRPCRequest(jsonRpcRequestMethod, [[data]]);
		}
	}

	/** read smart contract method */
	public async readSmartContract(readData: IReadData): Promise<Array<IContractReadOperationData>> {
		// request data
		const data = {
			max_gas: readData.maxGas,
			simulated_gas_price: readData.simulatedGasPrice.toString(),
			target_address: readData.targetAddress,
			target_function: readData.targetFunction,
			parameter: readData.parameter,
			caller_address: readData.callerAddress || this.walletClient.getBaseAccount().address
		};
		// returns operation ids
		const jsonRpcRequestMethod = JSON_RPC_REQUEST_METHOD.EXECUTE_READ_ONLY_CALL;
		if (this.clientConfig.retryStrategyOn) {
			return await trySafeExecute<Array<IContractReadOperationData>>(this.sendJsonRPCRequest, [jsonRpcRequestMethod, [[data]]]);
		} else {
			return await this.sendJsonRPCRequest(jsonRpcRequestMethod, [[data]]);
		}
	}

	/** Returns the parallel balance which is the smart contract side balance  */
	public async getParallelBalance(address: string): Promise<IBalance | null> {
		const addresses: Array<IAddressInfo> = await this.publicApiClient.getAddresses([address]);
		if (addresses.length === 0) return null;
		const addressInfo: IAddressInfo = addresses.at(0);
		return {
			candidate: addressInfo.candidate_sce_ledger_info.balance,
			final: addressInfo.final_sce_ledger_info.balance
		} as IBalance;
	}

	/** get filtered smart contract events */
	public async getFilteredScOutputEvents(eventFilterData: IEventFilter): Promise<Array<IEvent>> {

		const data = {
			start: eventFilterData.start,
			end: eventFilterData.end,
			emitter_address: eventFilterData.emitter_address,
			original_caller_address: eventFilterData.original_caller_address,
			original_operation_id: eventFilterData.original_operation_id,
		};

		const jsonRpcRequestMethod = JSON_RPC_REQUEST_METHOD.GET_FILTERED_SC_OUTPUT_EVENT;

		// returns filtered events
		if (this.clientConfig.retryStrategyOn) {
			return await trySafeExecute<Array<IEvent>>(this.sendJsonRPCRequest, [jsonRpcRequestMethod, [data]]);
		} else {
			return await this.sendJsonRPCRequest<Array<IEvent>>(jsonRpcRequestMethod, [data]);
		}
	}

	/** Returns the smart contract data storage for a given key */
	public async getDatastoreEntry(smartContractAddress: string, key: string): Promise<IContractStorageData | null> {
		const addresses: Array<IAddressInfo> = await this.publicApiClient.getAddresses([smartContractAddress]);
		if (addresses.length === 0) return null;
		const addressInfo: IAddressInfo = addresses.at(0);
		const base58EncodedKey: string = base58Encode(Buffer.from(hashBlake3(key)));
		const candidateLedgerInfo: Array<number>|null = addressInfo.candidate_sce_ledger_info.datastore[base58EncodedKey];
		const finalLedgerInfo: Array<number>|null = addressInfo.final_sce_ledger_info.datastore[base58EncodedKey];
		if (!candidateLedgerInfo || !finalLedgerInfo) return null;
		return {
			candidate: candidateLedgerInfo.map((s) => String.fromCharCode(s)).join(""),
			final: finalLedgerInfo.map((s) => String.fromCharCode(s)).join("")
		} as IContractStorageData;
	}

	/** Read-only smart contracts */
	public async executeReadOnlySmartContract(contractData: IContractData): Promise<Array<IExecuteReadOnlyResponse>> {

		if (!contractData.contractDataBinary) {
			throw new Error(`Contract binary data required. Got null`);
		}

		if (!contractData.address) {
			throw new Error(`Contract address required. Got null`);
		}

		const data = {
			max_gas: contractData.maxGas,
			simulated_gas_price: contractData.gasPrice.toString(),
			bytecode: Array.from(contractData.contractDataBinary),
			address: contractData.address,
		};

		const jsonRpcRequestMethod = JSON_RPC_REQUEST_METHOD.EXECUTE_READ_ONLY_BYTECODE;
		if (this.clientConfig.retryStrategyOn) {
			return await trySafeExecute<Array<IExecuteReadOnlyResponse>>(this.sendJsonRPCRequest, [jsonRpcRequestMethod, [[data]]]);
		} else {
			return await this.sendJsonRPCRequest<Array<IExecuteReadOnlyResponse>>(jsonRpcRequestMethod, [[data]]);
		}
	}

	public async getOperationStatus(opId: string): Promise<EOperationStatus> {
		const operationData: Array<IOperationData> = await this.publicApiClient.getOperations([opId]);
		if (!operationData || operationData.length === 0) return EOperationStatus.NOT_FOUND;
		const opData = operationData[0];
		if (opData.is_final) {
			return EOperationStatus.FINAL;
		}
		if (opData.in_blocks.length > 0) {
			return EOperationStatus.INCLUDED_PENDING;
		}
		if (opData.in_pool) {
			return EOperationStatus.AWAITING_INCLUSION;
		}

		return EOperationStatus.INCONSISTENT;
	}

	public async awaitRequiredOperationStatus(opId: string, requiredStatus: EOperationStatus): Promise<EOperationStatus> {
		let errCounter = 0;
		let pendingCounter = 0;
		while (true) {
			let status = EOperationStatus.NOT_FOUND;
			try {
				status = await this.getOperationStatus(opId);
			}
			catch (ex) {
				if (++errCounter > 100) {
					const msg = `Failed to retrieve the tx status after 10 failed attempts for operation id: ${opId}.`;
					console.error(msg, ex);
					throw ex;
				}

				await wait(TX_POLL_INTERVAL_MS);
			}

			if (status == requiredStatus) {
				return status;
			}

			if (++pendingCounter > 1000) {
				const msg = `Getting the tx status for operation Id ${opId} took too long to conclude. We gave up after ${TX_POLL_INTERVAL_MS * TX_STATUS_CHECK_RETRY_COUNT}ms.`;
				console.warn(msg);
				throw new Error(msg);
			}

			await wait(TX_POLL_INTERVAL_MS);
		}
	}
}
