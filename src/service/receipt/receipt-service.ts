/*
 * Copyright (c) TIKI Inc.
 * MIT license. See LICENSE file in root directory.
 */

import type { ReceiptCapture } from "@mytiki/tiki-capture-receipt-capacitor";
import * as TikiReceiptCapture from "@mytiki/tiki-capture-receipt-capacitor";
import { TikiService } from "@/service/tiki-service";
import { ReceiptAccount } from "@/service/receipt/receipt-account";
import { ReceiptEvent } from "@/service/receipt/receipt-event";
import { HistoryEvent } from "@/service/history/history-event";
import type { ScanType } from "./receipt-account-type";

/**
 * Service responsible for handling receipt-related operations and events.
 */
export class ReceiptService {
  /**
   * OCR confidence threshold for considering a receipt scan valid.
   */
  static readonly OCR_THRESHOLD = 0.9;

  /**
   * The raw plugin instance. Use to call {@link TikiReceiptCapture} directly.
   */
  readonly plugin: ReceiptCapture = TikiReceiptCapture.instance;

  /**
   * The local cached accounts
   */
  get cachedAccounts(){
    return this._accounts
  }

  private readonly tiki: TikiService;
  private _accounts: ReceiptAccount[] = [];
  private _onAccountListeners: Map<string, (account: ReceiptAccount) => void> = new Map();
  private _onReceiptListeners: Map<
    string,
    (receipt: TikiReceiptCapture.Receipt, account?: ReceiptAccount) => void
  > = new Map();

  /**
   * Creates an instance of the ReceiptService class.
   * 
   * Do not construct directly. Call from {@link TikiService}.
   * 
   * @param tiki {TikiService} The parent service instance.
   */
  constructor(tiki: TikiService) {
    this.tiki = tiki;
  }

  /**
   * Initializes the Microblink SDK.
   * 
   * Ask your account manager for the keys.
   * 
   * @param scanKey {string} Microblink scan Key
   * @param intelKey {string} Microblik product intel key
   */
  async initialize(scanKey: string, intelKey: string) {
    await this.plugin.initialize(scanKey, intelKey)
      .catch(error => {
        throw Error(`Could not initialize; Error: ${error}`)
      })
  }

  /**
   * Login into a retailer or email account to scan for receipts.
   * 
   * @param account {ReceiptAccount} The account to login.
   */
  async login(account: ReceiptAccount): Promise<void> {
    await this.plugin.login(
      account.username,
      account.password!,
      account.accountType.key!,
    )
    account.isVerified = true;
    this.addAccount(account);
    await this.process(ReceiptEvent.LINK, {
      account: account,
    });
  }
  
  /**
   * Log out from one or all {@link ReceiptAccount}.
   * 
   * The logout method will remove the credentials from the cache and remove all 
   * cached data for this account.
   * 
   * @param {ReceiptAccount} account - which account logout from. Logout from all 
   * accounts if undefined.
   */
  async logout(account: ReceiptAccount | undefined = undefined) {
    if (!account) {
      await this.plugin.logout()
      this._accounts = [];
      return
    }
    await this.plugin.logout(account.username, account.password, account.accountType.key)
    this.removeAccount(account!);
    await this.process(ReceiptEvent.UNLINK, {
      account: account,
    });
  }

  /**
   * Retrieves all saved accounts from capture plugin.
   */
  async accounts() {
    try {
      (await this.plugin.accounts()).forEach((account) => {
        this.addAccount(ReceiptAccount.fromValue(account))
        this.scan('ONLINE', ReceiptAccount.fromValue(account))
      })
    } catch (error) {
      throw Error(`Could not load the accounts; Error: ${error}`)
    }
  }

  /**
   * Scan for receipts.
   * 
   * @param scanType 
   * @param account 
   */
  async scan(scanType: ScanType | undefined, account?: ReceiptAccount): Promise<void> {
    if (scanType === 'PHYSICAL') {
      const license = await this.tiki.sdk.getLicense();
      if (license != undefined) {
        const receipt = await this.plugin.scan(scanType);
        if (receipt.receipt.ocrConfidence > ReceiptService.OCR_THRESHOLD) {
          await this.addReceipt(receipt.receipt);
        } else {
          console.warn(`Receipt ignored: Confidence: ${receipt.receipt.ocrConfidence}`);
        }
      } else
        throw Error(
          `No license found for ${this.tiki.sdk.id}. User must first consent to the program.`,
        );
    }
    if (!scanType) {
      const receipts = await this.plugin.scan('ONLINE', account!);
      this.addReceipt(receipts.receipt)
    }
  }

  /**
   * Register an account event listener.
   * 
   * @param id - Identifier for the listener.
   * @param listener - The callback function to be called when a new account is added or removed.
   */
  onAccount(id: string, listener: (account: ReceiptAccount) => void): void {
    this._onAccountListeners.set(id, listener);
  }

  /**
   * Register a receipt event listener.
   * 
   * @param id - Identifier for the listener.
   * @param listener - The callback function to be called whenever a new receipt is parsed.
   */
  onReceipt(
    id: string,
    listener: (
      receipt: TikiReceiptCapture.Receipt,
      account?: ReceiptAccount,
    ) => void,
  ) {
    this._onReceiptListeners.set(id, listener);
  }

  private addAccount(account: ReceiptAccount): void {
    this._accounts.push(account);
    this._onAccountListeners.forEach((listener) => listener(account));
    this.scan('ONLINE', account)
  }

  private removeAccount(account: ReceiptAccount): void {
    this._accounts = this._accounts.filter(
      (acc) => acc.username != account.username && acc.accountType.type != account.accountType.type,
    );
    this._onAccountListeners.forEach((listener) => listener(account));
  }

  private async addReceipt(
    receipt: TikiReceiptCapture.Receipt,
    account?: TikiReceiptCapture.Account,
  ): Promise<void> {
    if (!receipt.duplicate && !receipt.fraudulent) {
      await this.tiki.sdk.ingest(receipt);
      await this.process(ReceiptEvent.SCAN, {
        receipt: receipt,
        account: ReceiptAccount.fromValue(account!),
      });
      this._onReceiptListeners.forEach((listener) =>
        listener(
          receipt,
          ReceiptAccount.fromValue(account!)
        ),
      );
    } else {
      console.warn(
        `Receipt ignored — duplicate: ${receipt.duplicate} | fraudulent: ${receipt.fraudulent} | confidence: ${receipt.ocrConfidence}`,
      );
    }
  }

  private async process(
    event: ReceiptEvent,
    details: {
      receipt?: TikiReceiptCapture.Receipt;
      account?: ReceiptAccount;
    },
  ): Promise<void> {
    const rewards = this.tiki.config.rewards;
    for (const reward of rewards) {
      const amount = reward.issuer(event, details);
      if (amount != undefined) {
        const historyEvent = HistoryEvent.new(
          amount,
          new Date(),
          event,
          details.account?.accountType.type?.valueOf(),
        );
        await this.tiki.sdk.createPayable(
          amount,
          historyEvent.name,
          details.receipt?.blinkReceiptId,
        );
        this.tiki.history.add(historyEvent);
      }
    }
  }
}
