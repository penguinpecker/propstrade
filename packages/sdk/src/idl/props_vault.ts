/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/props_vault.json`.
 */
export type PropsVault = {
  "address": "7qYRWwpmj3j3exVoBUJHzigcWmMN8ruPEdZdZrGzTJ7",
  "metadata": {
    "name": "propsVault",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Props.trade vault: holds funded-account capital and trades on GMTrade through data-less owner PDAs"
  },
  "instructions": [
    {
      "name": "acceptAdmin",
      "discriminator": [
        112,
        42,
        45,
        90,
        116,
        181,
        13,
        170
      ],
      "accounts": [
        {
          "name": "newAdmin",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "activateFunded",
      "discriminator": [
        55,
        74,
        71,
        62,
        69,
        163,
        174,
        205
      ],
      "accounts": [
        {
          "name": "trader",
          "writable": true,
          "signer": true,
          "relations": [
            "evaluation"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "profile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "trader"
              }
            ]
          }
        },
        {
          "name": "evaluation",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  118,
                  97,
                  108,
                  117,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "trader"
              },
              {
                "kind": "account",
                "path": "evaluation.index",
                "account": "evaluation"
              }
            ]
          }
        },
        {
          "name": "funded",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  117,
                  110,
                  100,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "evaluation"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  119,
                  110,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "funded"
              }
            ]
          }
        },
        {
          "name": "ownerUsdc",
          "writable": true
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "capitalVault",
          "writable": true
        },
        {
          "name": "solTreasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  111,
                  108,
                  95,
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "approvePayout",
      "discriminator": [
        188,
        233,
        111,
        145,
        229,
        102,
        28,
        145
      ],
      "accounts": [
        {
          "name": "riskAuthority",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "funded",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  117,
                  110,
                  100,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "funded.evaluation",
                "account": "fundedAccount"
              }
            ]
          },
          "relations": [
            "payout"
          ]
        },
        {
          "name": "payout",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  121,
                  111,
                  117,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "funded"
              },
              {
                "kind": "account",
                "path": "payout.seq",
                "account": "payoutRequest"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  119,
                  110,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "funded"
              }
            ]
          }
        },
        {
          "name": "ownerUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "trader"
        },
        {
          "name": "traderUsdc",
          "docs": [
            "paid by the SOL treasury, if missing."
          ],
          "writable": true
        },
        {
          "name": "capitalVault",
          "writable": true
        },
        {
          "name": "solTreasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  111,
                  108,
                  95,
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "buyEvaluation",
      "discriminator": [
        53,
        49,
        218,
        47,
        130,
        44,
        53,
        202
      ],
      "accounts": [
        {
          "name": "trader",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "tier",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "arg",
                "path": "tierId"
              }
            ]
          }
        },
        {
          "name": "profile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "trader"
              }
            ]
          }
        },
        {
          "name": "evaluation",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  118,
                  97,
                  108,
                  117,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "trader"
              },
              {
                "kind": "arg",
                "path": "index"
              }
            ]
          }
        },
        {
          "name": "traderUsdc",
          "writable": true
        },
        {
          "name": "feeVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "tierId",
          "type": "u16"
        },
        {
          "name": "index",
          "type": "u32"
        }
      ]
    },
    {
      "name": "cancelOrder",
      "discriminator": [
        95,
        129,
        237,
        240,
        8,
        49,
        223,
        132
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "The trader, or a risk authority."
          ],
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "funded",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  117,
                  110,
                  100,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "funded.evaluation",
                "account": "fundedAccount"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  119,
                  110,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "funded"
              }
            ]
          }
        },
        {
          "name": "ownerUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "marketConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market_config.market_token",
                "account": "marketConfig"
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "gmStore",
          "writable": true
        },
        {
          "name": "gmStoreWallet",
          "writable": true
        },
        {
          "name": "gmUser",
          "writable": true
        },
        {
          "name": "gmOrder",
          "writable": true
        },
        {
          "name": "orderEscrow",
          "writable": true
        },
        {
          "name": "gmEventAuthority"
        },
        {
          "name": "gmtradeProgram",
          "address": "Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "cancelPayout",
      "discriminator": [
        119,
        152,
        126,
        113,
        177,
        218,
        236,
        61
      ],
      "accounts": [
        {
          "name": "trader",
          "signer": true,
          "relations": [
            "funded"
          ]
        },
        {
          "name": "funded",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  117,
                  110,
                  100,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "funded.evaluation",
                "account": "fundedAccount"
              }
            ]
          },
          "relations": [
            "payout"
          ]
        },
        {
          "name": "payout",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  121,
                  111,
                  117,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "funded"
              },
              {
                "kind": "account",
                "path": "payout.seq",
                "account": "payoutRequest"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "closeCompletedOrder",
      "discriminator": [
        179,
        21,
        187,
        3,
        237,
        0,
        39,
        159
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "funded",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  117,
                  110,
                  100,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "funded.evaluation",
                "account": "fundedAccount"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  119,
                  110,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "funded"
              }
            ]
          }
        },
        {
          "name": "ownerUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "gmStore",
          "writable": true
        },
        {
          "name": "gmStoreWallet",
          "writable": true
        },
        {
          "name": "gmUser",
          "writable": true
        },
        {
          "name": "gmOrder",
          "writable": true
        },
        {
          "name": "orderEscrow",
          "writable": true
        },
        {
          "name": "gmEventAuthority"
        },
        {
          "name": "gmtradeProgram",
          "address": "Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "closeFunded",
      "discriminator": [
        12,
        92,
        55,
        21,
        100,
        65,
        63,
        99
      ],
      "accounts": [
        {
          "name": "riskAuthority",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "funded",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  117,
                  110,
                  100,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "funded.evaluation",
                "account": "fundedAccount"
              }
            ]
          }
        },
        {
          "name": "profile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "funded.trader",
                "account": "fundedAccount"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  119,
                  110,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "funded"
              }
            ]
          }
        },
        {
          "name": "ownerUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "capitalVault",
          "writable": true
        },
        {
          "name": "solTreasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  111,
                  108,
                  95,
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "closePosition",
      "discriminator": [
        123,
        134,
        81,
        0,
        49,
        68,
        98,
        98
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "The trader, or a risk authority for forced closes."
          ],
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "funded",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  117,
                  110,
                  100,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "funded.evaluation",
                "account": "fundedAccount"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  119,
                  110,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "funded"
              }
            ]
          }
        },
        {
          "name": "marketConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market_config.market_token",
                "account": "marketConfig"
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "gmStore"
        },
        {
          "name": "gmMarket",
          "writable": true
        },
        {
          "name": "gmUser",
          "writable": true
        },
        {
          "name": "gmPosition",
          "writable": true
        },
        {
          "name": "gmOrder",
          "writable": true
        },
        {
          "name": "orderEscrow",
          "writable": true
        },
        {
          "name": "gmEventAuthority"
        },
        {
          "name": "gmtradeProgram",
          "address": "Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "closePositionArgs"
            }
          }
        }
      ]
    },
    {
      "name": "depositCapital",
      "discriminator": [
        157,
        98,
        40,
        41,
        205,
        210,
        121,
        253
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "adminUsdc",
          "writable": true
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "capitalVault",
          "writable": true
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "feeVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "capitalVault",
          "docs": [
            "`init_if_needed`: anyone can create ATA(vault, USDC) first, which must not block initialize."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "solTreasury",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  111,
                  108,
                  95,
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "gmtradeProgram",
          "address": "Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo"
        },
        {
          "name": "gmtradeStore"
        },
        {
          "name": "program",
          "address": "7qYRWwpmj3j3exVoBUJHzigcWmMN8ruPEdZdZrGzTJ7"
        },
        {
          "name": "programData"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "configParams"
            }
          }
        }
      ]
    },
    {
      "name": "markBreached",
      "discriminator": [
        172,
        209,
        209,
        147,
        90,
        189,
        145,
        13
      ],
      "accounts": [
        {
          "name": "riskAuthority",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "funded",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  117,
                  110,
                  100,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "funded.evaluation",
                "account": "fundedAccount"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "openPosition",
      "discriminator": [
        135,
        128,
        47,
        77,
        15,
        152,
        240,
        49
      ],
      "accounts": [
        {
          "name": "trader",
          "signer": true,
          "relations": [
            "funded"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "funded",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  117,
                  110,
                  100,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "funded.evaluation",
                "account": "fundedAccount"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  119,
                  110,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "funded"
              }
            ]
          }
        },
        {
          "name": "ownerUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "marketConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market_config.market_token",
                "account": "marketConfig"
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "gmStore"
        },
        {
          "name": "gmMarket",
          "writable": true
        },
        {
          "name": "gmUser",
          "writable": true
        },
        {
          "name": "gmPosition",
          "writable": true
        },
        {
          "name": "gmOrder",
          "writable": true
        },
        {
          "name": "orderEscrow",
          "writable": true
        },
        {
          "name": "gmEventAuthority"
        },
        {
          "name": "gmtradeProgram",
          "address": "Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "openPositionArgs"
            }
          }
        }
      ]
    },
    {
      "name": "proposeAdmin",
      "discriminator": [
        121,
        214,
        199,
        212,
        87,
        39,
        117,
        234
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "recordEvaluationResult",
      "discriminator": [
        224,
        83,
        75,
        1,
        128,
        151,
        204,
        233
      ],
      "accounts": [
        {
          "name": "riskAuthority",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "evaluation",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  118,
                  97,
                  108,
                  117,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "evaluation.trader",
                "account": "evaluation"
              },
              {
                "kind": "account",
                "path": "evaluation.index",
                "account": "evaluation"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "passed",
          "type": "bool"
        },
        {
          "name": "finalEquity",
          "type": "i64"
        },
        {
          "name": "tradesRoot",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "rejectPayout",
      "discriminator": [
        132,
        253,
        62,
        185,
        233,
        224,
        155,
        223
      ],
      "accounts": [
        {
          "name": "riskAuthority",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "funded",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  117,
                  110,
                  100,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "funded.evaluation",
                "account": "fundedAccount"
              }
            ]
          },
          "relations": [
            "payout"
          ]
        },
        {
          "name": "payout",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  121,
                  111,
                  117,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "funded"
              },
              {
                "kind": "account",
                "path": "payout.seq",
                "account": "payoutRequest"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "reasonCode",
          "type": "u16"
        }
      ]
    },
    {
      "name": "requestPayout",
      "discriminator": [
        5,
        176,
        110,
        197,
        172,
        177,
        64,
        200
      ],
      "accounts": [
        {
          "name": "trader",
          "writable": true,
          "signer": true,
          "relations": [
            "funded"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "funded",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  117,
                  110,
                  100,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "funded.evaluation",
                "account": "fundedAccount"
              }
            ]
          }
        },
        {
          "name": "owner",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  119,
                  110,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "funded"
              }
            ]
          }
        },
        {
          "name": "ownerUsdc",
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "payout",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  121,
                  111,
                  117,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "funded"
              },
              {
                "kind": "account",
                "path": "funded.payout_seq",
                "account": "fundedAccount"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "restrict",
      "discriminator": [
        209,
        81,
        186,
        237,
        127,
        16,
        13,
        235
      ],
      "accounts": [
        {
          "name": "riskAuthority",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "funded",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  117,
                  110,
                  100,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "funded.evaluation",
                "account": "fundedAccount"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "restricted",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setAuthorities",
      "discriminator": [
        124,
        254,
        44,
        240,
        197,
        70,
        190,
        107
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "riskAuthorities",
          "type": {
            "vec": "pubkey"
          }
        },
        {
          "name": "kycAuthority",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setIdentity",
      "discriminator": [
        31,
        31,
        141,
        65,
        178,
        99,
        106,
        176
      ],
      "accounts": [
        {
          "name": "kycAuthority",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "profile",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "arg",
                "path": "wallet"
              }
            ]
          }
        },
        {
          "name": "identityLock",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  100,
                  101,
                  110,
                  116,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "arg",
                "path": "identityHash"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "wallet",
          "type": "pubkey"
        },
        {
          "name": "identityHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "setParams",
      "discriminator": [
        27,
        234,
        178,
        52,
        147,
        2,
        187,
        141
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "configParams"
            }
          }
        }
      ]
    },
    {
      "name": "setPauses",
      "discriminator": [
        48,
        80,
        200,
        227,
        66,
        244,
        226,
        122
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": {
            "defined": {
              "name": "pauses"
            }
          }
        }
      ]
    },
    {
      "name": "setProtection",
      "discriminator": [
        170,
        199,
        130,
        200,
        40,
        198,
        55,
        172
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "The trader, or a risk authority for forced closes."
          ],
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "funded",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  117,
                  110,
                  100,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "funded.evaluation",
                "account": "fundedAccount"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  119,
                  110,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "funded"
              }
            ]
          }
        },
        {
          "name": "marketConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market_config.market_token",
                "account": "marketConfig"
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "gmStore"
        },
        {
          "name": "gmMarket",
          "writable": true
        },
        {
          "name": "gmUser",
          "writable": true
        },
        {
          "name": "gmPosition",
          "writable": true
        },
        {
          "name": "gmOrder",
          "writable": true
        },
        {
          "name": "orderEscrow",
          "writable": true
        },
        {
          "name": "gmEventAuthority"
        },
        {
          "name": "gmtradeProgram",
          "address": "Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "setProtectionArgs"
            }
          }
        }
      ]
    },
    {
      "name": "sweepFees",
      "discriminator": [
        175,
        225,
        98,
        71,
        118,
        66,
        34,
        148
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "feeVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "capitalVault",
          "writable": true
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "sync",
      "discriminator": [
        4,
        219,
        40,
        164,
        21,
        157,
        189,
        88
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "funded",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  117,
                  110,
                  100,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "funded.evaluation",
                "account": "fundedAccount"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "topUpOwner",
      "discriminator": [
        46,
        209,
        13,
        85,
        19,
        52,
        125,
        211
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "funded",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  117,
                  110,
                  100,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "funded.evaluation",
                "account": "fundedAccount"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  119,
                  110,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "funded"
              }
            ]
          }
        },
        {
          "name": "solTreasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  111,
                  108,
                  95,
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "updateOrder",
      "discriminator": [
        54,
        8,
        208,
        207,
        34,
        134,
        239,
        168
      ],
      "accounts": [
        {
          "name": "trader",
          "signer": true,
          "relations": [
            "funded"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "funded",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  117,
                  110,
                  100,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "funded.evaluation",
                "account": "fundedAccount"
              }
            ]
          }
        },
        {
          "name": "owner",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  119,
                  110,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "funded"
              }
            ]
          }
        },
        {
          "name": "marketConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market_config.market_token",
                "account": "marketConfig"
              }
            ]
          }
        },
        {
          "name": "gmStore"
        },
        {
          "name": "gmMarket",
          "writable": true
        },
        {
          "name": "gmOrder",
          "writable": true
        },
        {
          "name": "gmEventAuthority"
        },
        {
          "name": "gmtradeProgram",
          "address": "Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "updateOrderArgs"
            }
          }
        }
      ]
    },
    {
      "name": "upsertMarket",
      "discriminator": [
        73,
        122,
        217,
        17,
        70,
        77,
        57,
        39
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "marketConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "marketToken"
              }
            ]
          }
        },
        {
          "name": "gmMarket"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "marketToken",
          "type": "pubkey"
        },
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "marketParams"
            }
          }
        }
      ]
    },
    {
      "name": "upsertTier",
      "discriminator": [
        238,
        232,
        181,
        0,
        157,
        149,
        0,
        202
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "tier",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u16"
        },
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "tierParams"
            }
          }
        }
      ]
    },
    {
      "name": "withdrawCapital",
      "discriminator": [
        82,
        32,
        82,
        118,
        160,
        116,
        65,
        104
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "adminUsdc",
          "writable": true
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "capitalVault",
          "writable": true
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdrawSolTreasury",
      "discriminator": [
        100,
        50,
        91,
        49,
        183,
        237,
        36,
        52
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "solTreasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  111,
                  108,
                  95,
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "lamports",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "evaluation",
      "discriminator": [
        212,
        70,
        25,
        106,
        239,
        24,
        93,
        220
      ]
    },
    {
      "name": "fundedAccount",
      "discriminator": [
        243,
        213,
        249,
        109,
        66,
        122,
        63,
        208
      ]
    },
    {
      "name": "identityLock",
      "discriminator": [
        248,
        246,
        9,
        101,
        144,
        56,
        209,
        232
      ]
    },
    {
      "name": "marketConfig",
      "discriminator": [
        119,
        255,
        200,
        88,
        252,
        82,
        128,
        24
      ]
    },
    {
      "name": "payoutRequest",
      "discriminator": [
        182,
        69,
        255,
        168,
        65,
        179,
        121,
        171
      ]
    },
    {
      "name": "tier",
      "discriminator": [
        18,
        149,
        18,
        34,
        50,
        201,
        207,
        55
      ]
    },
    {
      "name": "traderProfile",
      "discriminator": [
        99,
        135,
        170,
        100,
        49,
        79,
        225,
        169
      ]
    }
  ],
  "events": [
    {
      "name": "accountBreached",
      "discriminator": [
        13,
        23,
        23,
        163,
        10,
        177,
        199,
        234
      ]
    },
    {
      "name": "accountClosed",
      "discriminator": [
        19,
        250,
        79,
        236,
        91,
        80,
        148,
        48
      ]
    },
    {
      "name": "accountRestricted",
      "discriminator": [
        151,
        99,
        235,
        224,
        157,
        128,
        151,
        4
      ]
    },
    {
      "name": "capitalDeposited",
      "discriminator": [
        193,
        124,
        182,
        129,
        144,
        1,
        221,
        53
      ]
    },
    {
      "name": "capitalWithdrawn",
      "discriminator": [
        202,
        30,
        139,
        204,
        45,
        210,
        182,
        244
      ]
    },
    {
      "name": "completedOrderClosed",
      "discriminator": [
        82,
        165,
        207,
        110,
        81,
        70,
        218,
        68
      ]
    },
    {
      "name": "configChanged",
      "discriminator": [
        147,
        25,
        86,
        98,
        98,
        77,
        78,
        192
      ]
    },
    {
      "name": "evaluationPurchased",
      "discriminator": [
        236,
        7,
        10,
        61,
        193,
        209,
        76,
        136
      ]
    },
    {
      "name": "evaluationResolved",
      "discriminator": [
        176,
        38,
        204,
        76,
        223,
        133,
        148,
        143
      ]
    },
    {
      "name": "feesSwept",
      "discriminator": [
        96,
        218,
        115,
        136,
        74,
        170,
        202,
        172
      ]
    },
    {
      "name": "fundedActivated",
      "discriminator": [
        119,
        43,
        37,
        84,
        142,
        191,
        142,
        101
      ]
    },
    {
      "name": "identitySet",
      "discriminator": [
        207,
        143,
        155,
        168,
        233,
        175,
        52,
        179
      ]
    },
    {
      "name": "orderCancelled",
      "discriminator": [
        108,
        56,
        128,
        68,
        168,
        113,
        168,
        239
      ]
    },
    {
      "name": "orderRequested",
      "discriminator": [
        233,
        57,
        116,
        185,
        63,
        88,
        154,
        140
      ]
    },
    {
      "name": "orderUpdated",
      "discriminator": [
        172,
        140,
        210,
        241,
        108,
        117,
        122,
        145
      ]
    },
    {
      "name": "ownerToppedUp",
      "discriminator": [
        178,
        73,
        99,
        250,
        204,
        210,
        52,
        139
      ]
    },
    {
      "name": "payoutCancelled",
      "discriminator": [
        78,
        190,
        217,
        66,
        73,
        23,
        172,
        182
      ]
    },
    {
      "name": "payoutPaid",
      "discriminator": [
        64,
        207,
        193,
        176,
        14,
        102,
        54,
        159
      ]
    },
    {
      "name": "payoutRejected",
      "discriminator": [
        59,
        154,
        242,
        246,
        203,
        126,
        213,
        199
      ]
    },
    {
      "name": "payoutRequested",
      "discriminator": [
        65,
        18,
        121,
        118,
        19,
        164,
        79,
        166
      ]
    },
    {
      "name": "protectionSet",
      "discriminator": [
        85,
        187,
        36,
        64,
        195,
        98,
        226,
        124
      ]
    },
    {
      "name": "solTreasuryWithdrawn",
      "discriminator": [
        163,
        85,
        22,
        101,
        16,
        168,
        245,
        167
      ]
    },
    {
      "name": "synced",
      "discriminator": [
        114,
        244,
        163,
        97,
        99,
        80,
        164,
        70
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notUpgradeAuthority",
      "msg": "Signer is not the program's upgrade authority"
    },
    {
      "code": 6001,
      "name": "unauthorized",
      "msg": "Signer is not allowed to perform this action"
    },
    {
      "code": 6002,
      "name": "invalidParams",
      "msg": "Invalid parameters"
    },
    {
      "code": 6003,
      "name": "tooManyRiskAuthorities",
      "msg": "Too many risk authorities"
    },
    {
      "code": 6004,
      "name": "paused",
      "msg": "This action is paused"
    },
    {
      "code": 6005,
      "name": "tierDisabled",
      "msg": "Tier is disabled"
    },
    {
      "code": 6006,
      "name": "marketNotPure",
      "msg": "GMTrade market is not a pure USDC-USDC market of the pinned store"
    },
    {
      "code": 6007,
      "name": "marketMismatch",
      "msg": "Account does not match the market"
    },
    {
      "code": 6008,
      "name": "marketDisabled",
      "msg": "Market is not enabled for funded trading"
    },
    {
      "code": 6009,
      "name": "invalidEvaluationStatus",
      "msg": "Evaluation status does not allow this action"
    },
    {
      "code": 6010,
      "name": "invalidAccountStatus",
      "msg": "Funded account status does not allow this action"
    },
    {
      "code": 6011,
      "name": "notVerified",
      "msg": "Trader identity is not verified"
    },
    {
      "code": 6012,
      "name": "alreadyVerified",
      "msg": "Trader identity is already set"
    },
    {
      "code": 6013,
      "name": "alreadyFunded",
      "msg": "Trader already has an active funded account"
    },
    {
      "code": 6014,
      "name": "insufficientCapital",
      "msg": "Not enough unallocated capital"
    },
    {
      "code": 6015,
      "name": "invalidAmount",
      "msg": "Invalid amount"
    },
    {
      "code": 6016,
      "name": "zeroAcceptablePrice",
      "msg": "Acceptable price must be set"
    },
    {
      "code": 6017,
      "name": "invalidTriggerPrice",
      "msg": "Trigger price is required for this order type and not allowed otherwise"
    },
    {
      "code": 6018,
      "name": "invalidOrderType",
      "msg": "Order type not allowed here"
    },
    {
      "code": 6019,
      "name": "collateralExceedsBalance",
      "msg": "Collateral exceeds the account's available USDC"
    },
    {
      "code": 6020,
      "name": "leverageTooHigh",
      "msg": "Leverage above the market limit"
    },
    {
      "code": 6021,
      "name": "positionTooLarge",
      "msg": "Position size above the market limit"
    },
    {
      "code": 6022,
      "name": "exposureTooHigh",
      "msg": "Total exposure above the account limit"
    },
    {
      "code": 6023,
      "name": "marketOpenInterestCap",
      "msg": "Funded open interest cap reached for this market side"
    },
    {
      "code": 6024,
      "name": "noFreeSlot",
      "msg": "All position slots are in use"
    },
    {
      "code": 6025,
      "name": "tooManyOrders",
      "msg": "Too many open orders"
    },
    {
      "code": 6026,
      "name": "noPosition",
      "msg": "No position in this market and side"
    },
    {
      "code": 6027,
      "name": "orderNotTracked",
      "msg": "Order is not tracked by this account"
    },
    {
      "code": 6028,
      "name": "orderNotPending",
      "msg": "Order is no longer pending; close it with close_completed_order"
    },
    {
      "code": 6029,
      "name": "orderPending",
      "msg": "Order is still pending"
    },
    {
      "code": 6030,
      "name": "invalidOrderAccount",
      "msg": "Invalid GMTrade order account"
    },
    {
      "code": 6031,
      "name": "invalidPositionAccount",
      "msg": "Invalid GMTrade position account"
    },
    {
      "code": 6032,
      "name": "invalidRemainingAccounts",
      "msg": "Remaining accounts do not match the account state"
    },
    {
      "code": 6033,
      "name": "notFlat",
      "msg": "Account has open positions or orders"
    },
    {
      "code": 6034,
      "name": "noProfit",
      "msg": "No realized profit"
    },
    {
      "code": 6035,
      "name": "belowMinPayout",
      "msg": "Trader share below the minimum payout"
    },
    {
      "code": 6036,
      "name": "invalidPayoutStatus",
      "msg": "Payout status does not allow this action"
    },
    {
      "code": 6037,
      "name": "balanceChanged",
      "msg": "Account balance dropped since the payout request"
    },
    {
      "code": 6038,
      "name": "ownerFloatSufficient",
      "msg": "Owner SOL float is above the minimum"
    },
    {
      "code": 6039,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    }
  ],
  "types": [
    {
      "name": "accountBreached",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "funded",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "accountClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "funded",
            "type": "pubkey"
          },
          {
            "name": "principal",
            "type": "u64"
          },
          {
            "name": "usdcReturned",
            "type": "u64"
          },
          {
            "name": "lamportsReturned",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "accountRestricted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "funded",
            "type": "pubkey"
          },
          {
            "name": "restricted",
            "type": "bool"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "capitalDeposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "capitalVaultBalance",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "capitalWithdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "to",
            "type": "pubkey"
          },
          {
            "name": "capitalVaultBalance",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "closePositionArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "isLong",
            "type": "bool"
          },
          {
            "name": "sizeDeltaUsd",
            "docs": [
              "`u128::MAX` closes the whole position (GMTrade caps it to the position size)."
            ],
            "type": "u128"
          },
          {
            "name": "acceptablePrice",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "completedOrderClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "funded",
            "type": "pubkey"
          },
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "pendingAdmin",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "riskAuthorities",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "kycAuthority",
            "docs": [
              "`Pubkey::default()` until set."
            ],
            "type": "pubkey"
          },
          {
            "name": "usdcMint",
            "type": "pubkey"
          },
          {
            "name": "gmtradeProgram",
            "type": "pubkey"
          },
          {
            "name": "gmtradeStore",
            "type": "pubkey"
          },
          {
            "name": "capitalVault",
            "docs": [
              "ATA(vault, USDC), recorded at initialize."
            ],
            "type": "pubkey"
          },
          {
            "name": "traderShareBps",
            "type": "u16"
          },
          {
            "name": "minPayout",
            "type": "u64"
          },
          {
            "name": "ownerSolTarget",
            "type": "u64"
          },
          {
            "name": "ownerSolMin",
            "type": "u64"
          },
          {
            "name": "paused",
            "type": {
              "defined": {
                "name": "pauses"
              }
            }
          },
          {
            "name": "feesCollected",
            "docs": [
              "Totals, USDC base units."
            ],
            "type": "u64"
          },
          {
            "name": "allocatedPrincipal",
            "type": "u64"
          },
          {
            "name": "payoutsPaid",
            "type": "u64"
          },
          {
            "name": "profitToVault",
            "type": "u64"
          },
          {
            "name": "evaluationsSold",
            "type": "u64"
          },
          {
            "name": "fundedActivated",
            "type": "u64"
          },
          {
            "name": "fundedActive",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          },
          {
            "name": "feeVaultBump",
            "type": "u8"
          },
          {
            "name": "solTreasuryBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "configChange",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "initialized"
          },
          {
            "name": "adminProposed"
          },
          {
            "name": "adminAccepted"
          },
          {
            "name": "authorities"
          },
          {
            "name": "params"
          },
          {
            "name": "pauses"
          },
          {
            "name": "tier"
          },
          {
            "name": "market"
          }
        ]
      }
    },
    {
      "name": "configChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "change",
            "type": {
              "defined": {
                "name": "configChange"
              }
            }
          },
          {
            "name": "subject",
            "docs": [
              "The admin, the new admin, the tier or the market config, depending on `change`."
            ],
            "type": "pubkey"
          },
          {
            "name": "paused",
            "type": {
              "defined": {
                "name": "pauses"
              }
            }
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "configParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "traderShareBps",
            "type": "u16"
          },
          {
            "name": "minPayout",
            "docs": [
              "Minimum trader share of a payout, USDC base units."
            ],
            "type": "u64"
          },
          {
            "name": "ownerSolTarget",
            "docs": [
              "Owner PDA SOL float, lamports: topped up to `owner_sol_target` whenever it drops below `owner_sol_min`."
            ],
            "type": "u64"
          },
          {
            "name": "ownerSolMin",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "evaluation",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "index",
            "type": "u32"
          },
          {
            "name": "tierId",
            "type": "u16"
          },
          {
            "name": "terms",
            "type": {
              "defined": {
                "name": "terms"
              }
            }
          },
          {
            "name": "feePaid",
            "type": "u64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "evaluationStatus"
              }
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "resolvedAt",
            "type": "i64"
          },
          {
            "name": "finalEquity",
            "docs": [
              "Micro-USD."
            ],
            "type": "i64"
          },
          {
            "name": "tradesRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "evaluationPurchased",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "evaluation",
            "type": "pubkey"
          },
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "tierId",
            "type": "u16"
          },
          {
            "name": "tierVersion",
            "type": "u32"
          },
          {
            "name": "feePaid",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "evaluationResolved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "evaluation",
            "type": "pubkey"
          },
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "passed",
            "type": "bool"
          },
          {
            "name": "finalEquity",
            "type": "i64"
          },
          {
            "name": "tradesRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "evaluationStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "active"
          },
          {
            "name": "passed"
          },
          {
            "name": "failed"
          },
          {
            "name": "funded"
          }
        ]
      }
    },
    {
      "name": "feesSwept",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "fundedAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "evaluation",
            "type": "pubkey"
          },
          {
            "name": "terms",
            "type": {
              "defined": {
                "name": "terms"
              }
            }
          },
          {
            "name": "principal",
            "docs": [
              "USDC posted from the capital vault (= L)."
            ],
            "type": "u64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "fundedStatus"
              }
            }
          },
          {
            "name": "slots",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "slot"
                  }
                },
                8
              ]
            }
          },
          {
            "name": "orders",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "trackedOrder"
                  }
                },
                8
              ]
            }
          },
          {
            "name": "orderSeq",
            "docs": [
              "GMTrade orders created so far; the next order's nonce (see `next_order_nonce`)."
            ],
            "type": "u64"
          },
          {
            "name": "payoutsPaid",
            "type": "u64"
          },
          {
            "name": "payoutSeq",
            "type": "u32"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "lastSyncAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "ownerBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "fundedActivated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "funded",
            "type": "pubkey"
          },
          {
            "name": "evaluation",
            "type": "pubkey"
          },
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "principal",
            "type": "u64"
          },
          {
            "name": "ownerLamports",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "fundedStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "active"
          },
          {
            "name": "restricted"
          },
          {
            "name": "payoutPending"
          },
          {
            "name": "breached"
          },
          {
            "name": "closed"
          }
        ]
      }
    },
    {
      "name": "identityLock",
      "docs": [
        "One per person: `init`-only, so an identity can be attached to one wallet."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "profile",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "identitySet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "profile",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "identityHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "marketConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketToken",
            "type": "pubkey"
          },
          {
            "name": "gmMarket",
            "docs": [
              "GMTrade Market account (pure USDC-USDC, verified at upsert)."
            ],
            "type": "pubkey"
          },
          {
            "name": "enabled",
            "type": "bool"
          },
          {
            "name": "indexSymbol",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "maxLeverageBps",
            "type": "u32"
          },
          {
            "name": "closedMaxLeverageBps",
            "type": "u32"
          },
          {
            "name": "maxPositionUsd",
            "type": "u64"
          },
          {
            "name": "maxTotalOiUsd",
            "type": "u64"
          },
          {
            "name": "oiLongUsd",
            "docs": [
              "Committed funded open interest (synced size + pending increase orders), GMTrade USD."
            ],
            "type": "u128"
          },
          {
            "name": "oiShortUsd",
            "type": "u128"
          },
          {
            "name": "sessionRestricted",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "marketParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "enabled",
            "type": "bool"
          },
          {
            "name": "indexSymbol",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "maxLeverageBps",
            "docs": [
              "Leverage limits as size / collateral in bps (25× = 250_000)."
            ],
            "type": "u32"
          },
          {
            "name": "closedMaxLeverageBps",
            "type": "u32"
          },
          {
            "name": "maxPositionUsd",
            "docs": [
              "Per funded position, micro-USD."
            ],
            "type": "u64"
          },
          {
            "name": "maxTotalOiUsd",
            "docs": [
              "All funded accounts together, per side, micro-USD."
            ],
            "type": "u64"
          },
          {
            "name": "sessionRestricted",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "openPositionArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "isLong",
            "type": "bool"
          },
          {
            "name": "orderType",
            "docs": [
              "`Market` or `Limit`."
            ],
            "type": {
              "defined": {
                "name": "orderType"
              }
            }
          },
          {
            "name": "collateral",
            "docs": [
              "USDC base units moved from the owner ATA into the order."
            ],
            "type": "u64"
          },
          {
            "name": "sizeDeltaUsd",
            "docs": [
              "GMTrade USD (1 USD = 10^20)."
            ],
            "type": "u128"
          },
          {
            "name": "triggerPrice",
            "docs": [
              "GMTrade unit price; required for `Limit`, zero for `Market`."
            ],
            "type": "u128"
          },
          {
            "name": "acceptablePrice",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "orderCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "funded",
            "type": "pubkey"
          },
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "by",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "orderRequested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "funded",
            "type": "pubkey"
          },
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "marketToken",
            "type": "pubkey"
          },
          {
            "name": "isLong",
            "type": "bool"
          },
          {
            "name": "orderType",
            "type": {
              "defined": {
                "name": "orderType"
              }
            }
          },
          {
            "name": "sizeDeltaUsd",
            "type": "u128"
          },
          {
            "name": "collateral",
            "type": "u64"
          },
          {
            "name": "triggerPrice",
            "type": "u128"
          },
          {
            "name": "acceptablePrice",
            "type": "u128"
          },
          {
            "name": "by",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "orderType",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "market"
          },
          {
            "name": "limit"
          },
          {
            "name": "close"
          },
          {
            "name": "takeProfit"
          },
          {
            "name": "stopLoss"
          }
        ]
      }
    },
    {
      "name": "orderUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "funded",
            "type": "pubkey"
          },
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "sizeDeltaUsd",
            "type": {
              "option": "u128"
            }
          },
          {
            "name": "triggerPrice",
            "type": {
              "option": "u128"
            }
          },
          {
            "name": "acceptablePrice",
            "type": {
              "option": "u128"
            }
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "ownerToppedUp",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "funded",
            "type": "pubkey"
          },
          {
            "name": "lamports",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "pauses",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "newEvaluations",
            "type": "bool"
          },
          {
            "name": "trading",
            "type": "bool"
          },
          {
            "name": "payouts",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "payoutCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "funded",
            "type": "pubkey"
          },
          {
            "name": "request",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "payoutPaid",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "funded",
            "type": "pubkey"
          },
          {
            "name": "request",
            "type": "pubkey"
          },
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "traderAmount",
            "type": "u64"
          },
          {
            "name": "vaultAmount",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "payoutRejected",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "funded",
            "type": "pubkey"
          },
          {
            "name": "request",
            "type": "pubkey"
          },
          {
            "name": "reasonCode",
            "type": "u16"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "payoutRequest",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "funded",
            "type": "pubkey"
          },
          {
            "name": "trader",
            "type": "pubkey"
          },
          {
            "name": "seq",
            "type": "u32"
          },
          {
            "name": "balanceAtRequest",
            "docs": [
              "USDC base units."
            ],
            "type": "u64"
          },
          {
            "name": "profit",
            "type": "u64"
          },
          {
            "name": "traderAmount",
            "type": "u64"
          },
          {
            "name": "vaultAmount",
            "type": "u64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "payoutStatus"
              }
            }
          },
          {
            "name": "reasonCode",
            "type": "u16"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "resolvedAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "payoutRequested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "funded",
            "type": "pubkey"
          },
          {
            "name": "request",
            "type": "pubkey"
          },
          {
            "name": "seq",
            "type": "u32"
          },
          {
            "name": "balance",
            "type": "u64"
          },
          {
            "name": "profit",
            "type": "u64"
          },
          {
            "name": "traderAmount",
            "type": "u64"
          },
          {
            "name": "vaultAmount",
            "type": "u64"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "payoutStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "requested"
          },
          {
            "name": "paid"
          },
          {
            "name": "rejected"
          },
          {
            "name": "cancelled"
          }
        ]
      }
    },
    {
      "name": "protectionSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "funded",
            "type": "pubkey"
          },
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "marketToken",
            "type": "pubkey"
          },
          {
            "name": "isLong",
            "type": "bool"
          },
          {
            "name": "orderType",
            "type": {
              "defined": {
                "name": "orderType"
              }
            }
          },
          {
            "name": "sizeDeltaUsd",
            "type": "u128"
          },
          {
            "name": "triggerPrice",
            "type": "u128"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "setProtectionArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "isLong",
            "type": "bool"
          },
          {
            "name": "orderType",
            "docs": [
              "`TakeProfit` or `StopLoss`."
            ],
            "type": {
              "defined": {
                "name": "orderType"
              }
            }
          },
          {
            "name": "triggerPrice",
            "type": "u128"
          },
          {
            "name": "sizeDeltaUsd",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "slot",
      "docs": [
        "One GMTrade position (market, side) of a funded account. Free when `market_token` is default."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketToken",
            "type": "pubkey"
          },
          {
            "name": "gmPosition",
            "type": "pubkey"
          },
          {
            "name": "isLong",
            "type": "bool"
          },
          {
            "name": "collateral",
            "docs": [
              "Position collateral (USDC base units) and size (GMTrade USD) at the last sync."
            ],
            "type": "u64"
          },
          {
            "name": "sizeUsd",
            "type": "u128"
          },
          {
            "name": "pendingUsd",
            "docs": [
              "Σ size of tracked, pending increase orders on this slot."
            ],
            "type": "u128"
          },
          {
            "name": "lastSync",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "slotSnapshot",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketToken",
            "type": "pubkey"
          },
          {
            "name": "isLong",
            "type": "bool"
          },
          {
            "name": "sizeUsd",
            "type": "u128"
          },
          {
            "name": "collateral",
            "type": "u64"
          },
          {
            "name": "pendingUsd",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "solTreasuryWithdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lamports",
            "type": "u64"
          },
          {
            "name": "to",
            "type": "pubkey"
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "synced",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "funded",
            "type": "pubkey"
          },
          {
            "name": "slots",
            "type": {
              "vec": {
                "defined": {
                  "name": "slotSnapshot"
                }
              }
            }
          },
          {
            "name": "ordersDropped",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "ts",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "terms",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "sizeUsd",
            "docs": [
              "Account size S, micro-USD."
            ],
            "type": "u64"
          },
          {
            "name": "profitTargetBps",
            "type": "u16"
          },
          {
            "name": "maxDrawdownBps",
            "type": "u16"
          },
          {
            "name": "maxExposureBps",
            "type": "u16"
          },
          {
            "name": "traderShareBps",
            "type": "u16"
          },
          {
            "name": "termsHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "tierVersion",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "tier",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u16"
          },
          {
            "name": "sizeUsd",
            "type": "u64"
          },
          {
            "name": "feeUsdc",
            "type": "u64"
          },
          {
            "name": "profitTargetBps",
            "type": "u16"
          },
          {
            "name": "maxDrawdownBps",
            "type": "u16"
          },
          {
            "name": "maxExposureBps",
            "type": "u16"
          },
          {
            "name": "enabled",
            "type": "bool"
          },
          {
            "name": "termsHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "version",
            "docs": [
              "Incremented on every upsert; snapshotted into evaluations."
            ],
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "tierParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "sizeUsd",
            "docs": [
              "Account size S, micro-USD."
            ],
            "type": "u64"
          },
          {
            "name": "feeUsdc",
            "docs": [
              "Evaluation fee, USDC base units."
            ],
            "type": "u64"
          },
          {
            "name": "profitTargetBps",
            "type": "u16"
          },
          {
            "name": "maxDrawdownBps",
            "type": "u16"
          },
          {
            "name": "maxExposureBps",
            "type": "u16"
          },
          {
            "name": "enabled",
            "type": "bool"
          },
          {
            "name": "termsHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "trackedOrder",
      "docs": [
        "A GMTrade order owned by the account's owner PDA. Free when `order` is default."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "slot",
            "type": "u8"
          },
          {
            "name": "orderType",
            "type": {
              "defined": {
                "name": "orderType"
              }
            }
          },
          {
            "name": "sizeUsd",
            "type": "u128"
          },
          {
            "name": "collateral",
            "type": "u64"
          },
          {
            "name": "placedByRisk",
            "docs": [
              "Orders placed by a risk authority (forced closes) cannot be cancelled by the trader."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "traderProfile",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "identityHash",
            "docs": [
              "Zero until the KYC authority verifies the wallet."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "verifiedAt",
            "type": "i64"
          },
          {
            "name": "activeFunded",
            "type": "u8"
          },
          {
            "name": "evaluationCount",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "updateOrderArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "triggerPrice",
            "type": {
              "option": "u128"
            }
          },
          {
            "name": "acceptablePrice",
            "type": {
              "option": "u128"
            }
          },
          {
            "name": "sizeDeltaUsd",
            "type": {
              "option": "u128"
            }
          }
        ]
      }
    }
  ]
};
