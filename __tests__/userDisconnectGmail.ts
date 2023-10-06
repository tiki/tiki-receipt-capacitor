import { StateAccount } from "../src/service/store/state/state-account";
import { ServiceStore } from "../src/service/store";
import connectGmail from "./__fixtures__/connectGmail";
import connectRetailer from "./__fixtures__/connectRetailer";
import fiveReceipts from "./__fixtures__/fiveReceipts";
import fourWeeks from "./__fixtures__/fourWeeks";
import mockCheckPayout from "./__mocks__/mockCheckPayout";

describe("User disconnect Gmail", () => {
  test("test suite", async () => {
    const store = new ServiceStore();
    const gmail = store.gmail as StateAccount;
    expect(connectGmail(gmail)).toBe("P100");

    await gmail.update([]);
    const gmailStatus = gmail.get().value;
    expect(gmailStatus).toBe("NULL");

    const retailer = store.retailer as StateAccount
    expect(connectRetailer(retailer)).toBe("P100");

    expect(fourWeeks(store.sync)).toBe(4);
    
    expect(fiveReceipts(store.receipt)).toBe(5);

    expect(
      mockCheckPayout(
        store.sync.countWeeks(new Date("09/27/2023")),
        store.receipt.count(),
        gmail.get().value,
        retailer.get().value
      )
    ).toBeFalsy();
  });
});