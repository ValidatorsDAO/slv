// Description: Version constants for the application.
// e.g.: VERSION + SOLANA CLI NAME + NETWORK = '0.0.1' only numbers and dots

// SLV version
export const VERSION = '2026.6.6.2026'

// Component versions
// VERSION_SOLANA_* and VERSION_JITO_* are the RPC defaults of a network.
// Validators use the *_VALIDATOR_* values and the allnodes values.
//
// Alpenglow starts on mainnet with epoch 1064 and needs agave or jito built on
// Agave 4.3.0 or later; testnet and devnet already run it on 4.4.0-beta.*.
// A Geyser RPC default pairs a client with a plugin built for it. Mainnet uses
// the latest Yellowstone release built for solana 4.3.0. Yellowstone's only 4.4
// build, a tag without a release, is built for 4.4.0-beta.0, so the testnet and
// devnet RPC defaults stay on 4.4.0-beta.0 while the testnet validators run
// 4.4.0-beta.1.
export const VERSION_SOLANA_TESTNET = '4.4.0-beta.0'
export const VERSION_SOLANA_DEVNET = '4.4.0-beta.0'
export const VERSION_SOLANA_MAINNET = '4.3.2'
export const VERSION_JITO_TESTNET = '4.4.0-beta.0-jito'
export const VERSION_JITO_DEVNET = '4.4.0-beta.0-jito'
export const VERSION_JITO_MAINNET = '4.3.1-jito'
// Only validators carry an allnodes version; the RPC sections have none.
export const VERSION_ALLNODES_JITO_MAINNET = '4.3.2-allnodes'
export const VERSION_ALLNODES_JITO_TESTNET = '4.4.0-beta.1-allnodes'
export const VERSION_RICHAT = 'richat-v8.2.2'
export const VERSION_OF1 = 'v0.7.14'
export const VERSION_FIREDANCER_TESTNET = '0.814.30108'
export const VERSION_FIREDANCER_DEVNET = '0.814.30108'
export const VERSION_FIREDANCER_MAINNET = '0.814.30108'
export const VERSION_GEYSER_YELLOWSTONE_TESTNNET = 'v17.0.0-rc5+solana.4.4.0.beta.0'
export const VERSION_GEYSER_YELLOWSTONE_DEVNET = 'v17.0.0-rc5+solana.4.4.0.beta.0'
export const VERSION_GEYSER_YELLOWSTONE_MAINNET = 'v16.1.1+solana.4.3.0'

// Validator defaults.
export const VERSION_SOLANA_VALIDATOR_MAINNET = '4.3.2'
export const VERSION_JITO_VALIDATOR_MAINNET = '4.3.1-jito'
export const VERSION_SOLANA_VALIDATOR_TESTNET = '4.4.0-beta.1'
export const VERSION_JITO_VALIDATOR_TESTNET = '4.4.0-beta.1-jito'
