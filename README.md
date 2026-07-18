# JavaScript DApp Template

This is a template for JavaScript Cartesi DApps. It uses node to execute the backend application.
The application entrypoint is the `src/index.js` file. It is bundled with [esbuild](https://esbuild.github.io), but any bundler can be used.

## Common Ethereum Function Selectors

This section provides a reusable list of common Keccak-256 function selectors for Ethereum smart contracts, including standard ERC interfaces and Cartesi-specific ones. These are useful for generating/validating vouchers, ABI interactions, or debugging calldata in your DApp.

### Usage
- See `selectors.js` for a JavaScript array export.
- To compute a new selector: Use Foundry's `cast sig "functionName(type1,type2)"` or online tools like 4byte.directory.
- Example in JS: Filter for a specific selector:
  ```javascript
  const selectors = require('./selectors.js');
  const withdrawSelector = selectors.find(s => s.signature === 'withdrawEther(address,uint256)').selector;
  console.log(withdrawSelector);  // Outputs: 0x522f6815