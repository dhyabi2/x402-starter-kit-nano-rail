/**
 * Offline unit test for the NanoProvider — verifies amount math and
 * requirement shape without sending any Nano RPC calls.
 *
 * Run:  npm run test:nano
 */
import { xnoToRaw, rawToXno, NanoProvider } from './NanoProvider.js';

let failures = 0;
let passed = 0;

function assert(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
  } else {
    failures++;
    console.error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function assertEqual(label: string, a: any, b: any) {
  assert(label, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// 1. Amount conversion: 1 XNO = 1e30 raw
assertEqual('1 XNO = 1e30 raw', xnoToRaw(1), '1000000000000000000000000000000');

// 2. Amount conversion: 0.001 XNO = 1e27 raw
assertEqual('0.001 XNO = 1e27 raw', xnoToRaw(0.001), '1000000000000000000000000000');

// 3. Amount conversion: 0.1 XNO = 1e29 raw
assertEqual('0.1 XNO = 1e29 raw', xnoToRaw(0.1), '100000000000000000000000000000');

// 4. Round-trip: raw -> XNO -> raw preserves value within machine epsilon
assertEqual('round-trip 0.001 XNO', rawToXno('1000000000000000000000000000'), 0.001);

// 5. Negative amounts throw
try {
  xnoToRaw(-1);
  assert('negative amount throws', false);
} catch (e: any) {
  assert('negative amount throws', e.message.includes('Invalid Nano amount'));
}

// 6. Invalid payTo address rejects
try {
  new NanoProvider({
    payToAddress: '0xdeadbeef',
    network: 'nano:mainnet',
    price: 0.1,
    fetchFn: async () => new Response('{}'),
  });
  assert('invalid payTo: 0x address', false);
} catch (e: any) {
  assert('invalid payTo: 0x address', e.message.includes('payToAddress must be a nano_'));
}

// 7. Valid nano_ payTo accepted
const provider = new NanoProvider({
  payToAddress: 'nano_1qno3z1izxpgfgi8d3x3yggd3p97bq3xci3kdh71dfgnokrni3pacjm8od9y',
  network: 'nano:mainnet',
  price: 0.1,
  fetchFn: async () => new Response('{}'),
});
assert('valid nano_ payTo accepted', true);

// 8. Requirements shape
const req = provider.buildRequirements();
assertEqual('scheme is exact', req.scheme, 'exact');
assertEqual('network is nano:mainnet', req.network, 'nano:mainnet');
assertEqual('asset is XNO', req.asset, 'XNO');
assertEqual('payTo has nano_ prefix', req.payTo.startsWith('nano_'), true);
assertEqual('amount is 0.1 XNO in raw', req.amount, '100000000000000000000000000000');
assertEqual('extra.name is Nano', req.extra.name, 'Nano');
assertEqual('extra.version is 2', req.extra.version, '2');
assertEqual('extra.work is required', req.extra.work, 'required');
assertEqual('maxTimeoutSeconds is a positive number', typeof req.maxTimeoutSeconds, 'number');

// 9. Payment required response shape
const resp = provider.createPaymentRequiredResponse();
assertEqual('x402 version in response', resp.x402Version, 2);
assert('accepts is an array', Array.isArray(resp.accepts));
assertEqual('accepts has one entry', resp.accepts.length, 1);
assertEqual('respondent accepts network', resp.accepts[0].network, 'nano:mainnet');

// 10. confirmPayment with an invalid block hash returns invalid
const offlineCheck = await provider.confirmPayment('', 'test-req-1');
assert('offline confirm with empty hash returns not-valid', offlineCheck.isValid === false);
assertEqual('reason mentions hash format', (offlineCheck.invalidReason || '').includes('hash format'), true);

// 11. settle without a prior verification returns failure
const offlineSettle = await provider.settle('never-verified-req');
assertEqual('offline settle returns failure', offlineSettle.success, false);

// 12. Test network
const testProvider = new NanoProvider({
  payToAddress: 'nano_1qno3z1izxpgfgi8d3x3yggd3p97bq3xci3kdh71dfgnokrni3pacjm8od9y',
  network: 'nano:nano-test-network',
  price: 0.001,
  fetchFn: async () => new Response('{}'),
});
const testReq = testProvider.buildRequirements();
assertEqual('test network is nano:nano-test-network', testReq.network, 'nano:nano-test-network');
assertEqual('test amount is 0.001 XNO', testReq.amount, '1000000000000000000000000000');

console.log(`\n📊 Results: ${passed} passed, ${failures} failed`);
if (failures > 0) {
  console.error('❌ Some tests failed');
  process.exit(1);
} else {
  console.log('✅ All tests passed');
}
