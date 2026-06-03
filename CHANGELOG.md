# Changelog

## [0.3.0](https://github.com/rpcpool/superbank/compare/v0.2.0...v0.3.0) (2026-05-26)


### Features

* add fumarole support to superbank ingest ([#84](https://github.com/rpcpool/superbank/issues/84)) ([80110cc](https://github.com/rpcpool/superbank/commit/80110ccb3067324c13f4dcd52b8d28cb4a083e34))


### Bug Fixes

* add proper timeout and failover controls to gIR ([#88](https://github.com/rpcpool/superbank/issues/88)) ([dcd18fc](https://github.com/rpcpool/superbank/commit/dcd18fc304ed809cab6392fa48829290ffad8700))
* **deps:** update rust dependencies (minor/patch) ([#24](https://github.com/rpcpool/superbank/issues/24)) ([7e88d61](https://github.com/rpcpool/superbank/commit/7e88d61755ca9190ff2e7b834c6b10fe5bc25f79))
* **rpc:** make gTFA slot upper-bound filters work ([#91](https://github.com/rpcpool/superbank/issues/91)) ([75264ec](https://github.com/rpcpool/superbank/commit/75264ec4d14054817517d5c6315e1b4ea607fa49))
* set dedicated channel capacity instead of relying on grpc semantics ([#89](https://github.com/rpcpool/superbank/issues/89)) ([16a486c](https://github.com/rpcpool/superbank/commit/16a486c1885df237d5cc7f92758eaf0833d6717b))

## [0.2.0](https://github.com/rpcpool/superbank/compare/v0.1.0...v0.2.0) (2026-04-29)


### ⚠ BREAKING CHANGES

* refactor routing ([#28](https://github.com/rpcpool/superbank/issues/28))

### Features

* `getSlot` and `getBlockHeight` support ([#14](https://github.com/rpcpool/superbank/issues/14)) ([dcdf0ef](https://github.com/rpcpool/superbank/commit/dcdf0ef3194f08153860e0a614ea9883643d3794))
* add format ([a6d5a79](https://github.com/rpcpool/superbank/commit/a6d5a798a40c4ae4d89a44fb9cc674eb2aa531c4))
* add getBlocksWithLimit support ([#33](https://github.com/rpcpool/superbank/issues/33)) ([aed385a](https://github.com/rpcpool/superbank/commit/aed385a684e10e2dd35a2a841e87e1f8da080493))
* add getInflationReward support ([#34](https://github.com/rpcpool/superbank/issues/34)) ([31cef84](https://github.com/rpcpool/superbank/commit/31cef84bd63e2500edc971680d4bb799f6cac657))
* add getLatestBlockHash support ([#15](https://github.com/rpcpool/superbank/issues/15)) ([c73e04d](https://github.com/rpcpool/superbank/commit/c73e04dc0cef6fd79192d44565291bcf7ab0564c))
* add getTransactionCount ([#62](https://github.com/rpcpool/superbank/issues/62)) ([26be62b](https://github.com/rpcpool/superbank/commit/26be62b1bfd31702cb1c41f1b41ebc964e107af0))
* add JSON-RPC batch support and k6 coverage ([#29](https://github.com/rpcpool/superbank/issues/29)) ([6654dd8](https://github.com/rpcpool/superbank/commit/6654dd85594c9071dbde6974b19715ea47406fa6))
* add minContextSlot ([2148582](https://github.com/rpcpool/superbank/commit/2148582f0d9576913327f9f12b5377c52f4c00f8))
* add poh entries to clickhouse ([1519af7](https://github.com/rpcpool/superbank/commit/1519af748e8043eced1685efd996f01daece93c3))
* add prometheus metrics to superbank ingest ([8fc643f](https://github.com/rpcpool/superbank/commit/8fc643f0646ba7453c6135406b7cf757ace5bf10))
* add prometheus metrics to superbank ingest ([0da3bcf](https://github.com/rpcpool/superbank/commit/0da3bcf17a57a162becb37ee0d39bcbdc5ea7aa9))
* add rpc server for gsfa ([aa24efb](https://github.com/rpcpool/superbank/commit/aa24efb1267494e0b3ef2989a6e33d7b454c5463))
* add shard-direct routing for getBlocks ([#36](https://github.com/rpcpool/superbank/issues/36)) ([6af8772](https://github.com/rpcpool/superbank/commit/6af8772c3bbbc7674b21129286590ab819a7b432))
* add signature,slot,slot_idx cache for stampede lookups ([#9](https://github.com/rpcpool/superbank/issues/9)) ([c97bc07](https://github.com/rpcpool/superbank/commit/c97bc074f3ab637c629740b9fba6c4f4b21d2a9c))
* add static cluster label to identify the cluster name ([a68f173](https://github.com/rpcpool/superbank/commit/a68f173a8bdc080937f88e276c7161469568ba94))
* add support for minimumLedgerSlot ([#77](https://github.com/rpcpool/superbank/issues/77)) ([fa66d87](https://github.com/rpcpool/superbank/commit/fa66d87fe64bf455526689f598747840c5c37d25))
* add support for slot filters in gT, gSFA, gTFA ([#76](https://github.com/rpcpool/superbank/issues/76)) ([3250f7c](https://github.com/rpcpool/superbank/commit/3250f7c29f753b1b9331fc5fc35bdf5519709044))
* add triton specific metrics updates ([#31](https://github.com/rpcpool/superbank/issues/31)) ([94a65eb](https://github.com/rpcpool/superbank/commit/94a65ebc93e94ba4067670ef043be2a47129093f))
* allow ClickHouse query cache for historical queries ([#18](https://github.com/rpcpool/superbank/issues/18)) ([1a8be89](https://github.com/rpcpool/superbank/commit/1a8be89d7ef9288a597635e721b1448f489bf2ee))
* create dragonsmouth adapter ([1ff5107](https://github.com/rpcpool/superbank/commit/1ff5107c51e023bf6e59358f01dd4100820db7f7))
* create dragonsmouth adapter ([3e18a28](https://github.com/rpcpool/superbank/commit/3e18a28140f0b909c92502e6dd35890f0672dd6a))
* gRPC head cache ([#10](https://github.com/rpcpool/superbank/issues/10)) ([5483c9e](https://github.com/rpcpool/superbank/commit/5483c9e2b9d09d08c5ecb0e7f362627ba150e3c2))
* manifold orchestration ([ecc0890](https://github.com/rpcpool/superbank/commit/ecc0890b50882c9472258bf3535091aa16f0c7a9))
* multi cluster ops ([#59](https://github.com/rpcpool/superbank/issues/59)) ([8688f99](https://github.com/rpcpool/superbank/commit/8688f991e3dd8941fd6ac9b53dc33cb852090a0b))
* refactor superbank-rpc for cluster generalization ([#49](https://github.com/rpcpool/superbank/issues/49)) ([e19d1f5](https://github.com/rpcpool/superbank/commit/e19d1f569eea522c2d6984afc20647f9cbe074d7))
* refactor routing ([#28](https://github.com/rpcpool/superbank/issues/28)) ([f4d4f38](https://github.com/rpcpool/superbank/commit/f4d4f3865223db5783e659af993e3b7785157f82))
* update to agave 4.0 where possible ([#79](https://github.com/rpcpool/superbank/issues/79)) ([54b62ca](https://github.com/rpcpool/superbank/commit/54b62caccbac958c5bd799337989175d002d2062))
* updates ([f083f49](https://github.com/rpcpool/superbank/commit/f083f4988b810bc3f85c2012a7a3da6cbef3aeda))


### Bug Fixes

* add dedicated block_meta subscriber ([#37](https://github.com/rpcpool/superbank/issues/37)) ([dc38a9f](https://github.com/rpcpool/superbank/commit/dc38a9fcb1fd2169cd29f4a0b3f84eb236decc02))
* add formatting and columns ([b4e6ce7](https://github.com/rpcpool/superbank/commit/b4e6ce7cd5ed107b452001b1bffcc5aef890ba3e))
* add script to check gSS confirmation status consistency ([41d2277](https://github.com/rpcpool/superbank/commit/41d22779b9d723ed3696f31a143c68fddb2f3cd7))
* add username/password options ([2dd4b6a](https://github.com/rpcpool/superbank/commit/2dd4b6ad38ab87c7871a4849745d72d4642e1d2c))
* align getBlock error codes with other implementations ([c0a7161](https://github.com/rpcpool/superbank/commit/c0a716182c8efb6f51c43a2e50e595f0180b8984))
* align getBlock error codes with other implementations ([c479391](https://github.com/rpcpool/superbank/commit/c4793914b824977ab5463fe5f5faacd217d1f084))
* allow non-spec compliant requests without id key ([#30](https://github.com/rpcpool/superbank/issues/30)) ([ed208d0](https://github.com/rpcpool/superbank/commit/ed208d046405663bd6a99573af863a43c4a5400a))
* allow startup TCP check to be configurable via CLICKHOUSE_TCP_ACCESS_CHECK_TIMEOUT_MS ([#27](https://github.com/rpcpool/superbank/issues/27)) ([279dbb2](https://github.com/rpcpool/superbank/commit/279dbb22d59a4a694bc2d5661056f4b166d74478))
* avoid parent timeout drops in shard TCP queries ([#80](https://github.com/rpcpool/superbank/issues/80)) ([3b1daeb](https://github.com/rpcpool/superbank/commit/3b1daeb45f0b912a237ffc650e50d51423f32376))
* batch request verify response and enforce empty body as error ([e62af7e](https://github.com/rpcpool/superbank/commit/e62af7e7c230e741f832945478322187af752e1e))
* CI ([deef23e](https://github.com/rpcpool/superbank/commit/deef23e569638cc80e550c5d3570d1a80c1f1b31))
* enforce query timeouts in shard-direct queries ([#66](https://github.com/rpcpool/superbank/issues/66)) ([37afd62](https://github.com/rpcpool/superbank/commit/37afd62c50b81b905075af8df97c1c349d8d3c6d))
* getBlock optimizations ([#58](https://github.com/rpcpool/superbank/issues/58)) ([298a7c3](https://github.com/rpcpool/superbank/commit/298a7c3681bc0210ed076d956db89f1922aa06a5))
* **getBlocks:** get blocks optimistic fetches ([#42](https://github.com/rpcpool/superbank/issues/42)) ([ac43114](https://github.com/rpcpool/superbank/commit/ac4311477d07ea8cfc3197f340e823e6cbad6228))
* **getBlocks:** use head-cache for optimistic last slot ([#41](https://github.com/rpcpool/superbank/issues/41)) ([db3f0b4](https://github.com/rpcpool/superbank/commit/db3f0b4e766bad6d413f52a375965cfa9b6c316e))
* gsfa boundary error under load with shard direct routing ([#44](https://github.com/rpcpool/superbank/issues/44)) ([7292092](https://github.com/rpcpool/superbank/commit/7292092b38e403b58f5fb71d3ae53c1c3af37703))
* ignore getSignatureStatuses commitment config ([91122b4](https://github.com/rpcpool/superbank/commit/91122b451c02dd3589c222d37039a3b78d717e8d))
* ignore getSignatureStatuses commitment config ([9862e13](https://github.com/rpcpool/superbank/commit/9862e1310ffa4207077eb9de76471191ba7c974f))
* ignore invalid tx early ([#17](https://github.com/rpcpool/superbank/issues/17)) ([daf8233](https://github.com/rpcpool/superbank/commit/daf8233ab72225b5596878d788550a5755f0e69d))
* implement proper timeout failover and query cancellation ([#69](https://github.com/rpcpool/superbank/issues/69)) ([1cec1f5](https://github.com/rpcpool/superbank/commit/1cec1f5fb1021b945ffaac14f74b805bcaa9303f))
* improve gsfa_hot gating logic ([#63](https://github.com/rpcpool/superbank/issues/63)) ([cdf3f4e](https://github.com/rpcpool/superbank/commit/cdf3f4e122b8be8a227d1c907dc9e13c5c397081))
* keep getSignatureStatuses confirmations consistent with confirmationStatus ([45d3af3](https://github.com/rpcpool/superbank/commit/45d3af39551e744f01a370e96aabefcb7325627c))
* keep getSignatureStatuses confirmations consistent with spec ([6f66573](https://github.com/rpcpool/superbank/commit/6f665737a6e4e91190d4b828013c0679630fda72))
* metrics refactor ([#40](https://github.com/rpcpool/superbank/issues/40)) ([e08eee0](https://github.com/rpcpool/superbank/commit/e08eee0aae05026590637196ea808a6d52c84893))
* panidc on stream errors ([fa040ca](https://github.com/rpcpool/superbank/commit/fa040ca73dab2e237ab423c04870552ee5452f47))
* port Agave getSignaturesForAddress cursor fix in superbank ([#78](https://github.com/rpcpool/superbank/issues/78)) ([d968a35](https://github.com/rpcpool/superbank/commit/d968a3542f6ce8bb607620560d8fdf0450bcb5a7))
* properly decode ALT's ([ab39e0c](https://github.com/rpcpool/superbank/commit/ab39e0c82b2b07218775c4136ac97db166c3792a))
* remove clickhouse deps from non-required crates ([cc45d7e](https://github.com/rpcpool/superbank/commit/cc45d7e99c90025c7e3b530a1e4e37041566ed75))
* remove signature from cursor queries ([#38](https://github.com/rpcpool/superbank/issues/38)) ([0c5eb03](https://github.com/rpcpool/superbank/commit/0c5eb03de4db2285ea2d0ca68ced830c8beaa9c6))
* rename x-token to x-endpoint in metrics ([#35](https://github.com/rpcpool/superbank/issues/35)) ([54a5c91](https://github.com/rpcpool/superbank/commit/54a5c91de57ea9ac524c1ef642210cea85e234db))
* reset to new schema layout ([fd45736](https://github.com/rpcpool/superbank/commit/fd457365f11a233108264ce0618361f67357769e))
* return proper error codes for gBT ([#43](https://github.com/rpcpool/superbank/issues/43)) ([d03119d](https://github.com/rpcpool/superbank/commit/d03119dfd50101e62cc43297d93926a7c5b1df19))
* revert 'remove signature from cursor queries' ([#39](https://github.com/rpcpool/superbank/issues/39)) ([e559246](https://github.com/rpcpool/superbank/commit/e559246539cb2cff43ab39ec720747b0c8c0019a))
* reward decoding case sensitivity ([#25](https://github.com/rpcpool/superbank/issues/25)) ([96b3822](https://github.com/rpcpool/superbank/commit/96b3822a1c73c1b83dce304b3c82fd79ce9cc8c7))
* **rpc:** align getSignaturesForAddress errors with Agave ([3584124](https://github.com/rpcpool/superbank/commit/35841243ef3f4ec668fa3c41bf8834a753385b8c))
* **rpc:** align getSignaturesForAddress errors with Agave ([0ca50f8](https://github.com/rpcpool/superbank/commit/0ca50f8628ec82dc77e66e6d18abda7730ae96e8))
* slot fetching logic rework ([#19](https://github.com/rpcpool/superbank/issues/19)) ([2d0aa24](https://github.com/rpcpool/superbank/commit/2d0aa2477c4a984eeda5f94ed767c6dd76164130))
* supersede renovate PR [#24](https://github.com/rpcpool/superbank/issues/24) dependency update ([#53](https://github.com/rpcpool/superbank/issues/53)) ([9a69b23](https://github.com/rpcpool/superbank/commit/9a69b23ccaa6eb2782781848229acb01e370b0ad))
* typescript deprecation error ([13c1401](https://github.com/rpcpool/superbank/commit/13c140114184327fe72aa1293f115adce987ef96))
* typo ([706efb3](https://github.com/rpcpool/superbank/commit/706efb366be006abad02c36f29496e8b2dec19ae))
* update args format ([314c985](https://github.com/rpcpool/superbank/commit/314c98554a244e17ade6c74c3cbdd9dd86db5da6))
* update local dev stack ([#12](https://github.com/rpcpool/superbank/issues/12)) ([12992a4](https://github.com/rpcpool/superbank/commit/12992a40de50db1ca4d4594ee5e8c5ff9b72b9a5))
* update logic for missing blocks in clickhouse ([8d01985](https://github.com/rpcpool/superbank/commit/8d01985a5835febcbe13f09d1cf054c45c5630f5))
* update logic for missing blocks in clickhouse ([7d61a87](https://github.com/rpcpool/superbank/commit/7d61a87dcc0a914a0faa227b6ba6ce77152a6f40))
* update release-please semantics ([#81](https://github.com/rpcpool/superbank/issues/81)) ([cdd78ed](https://github.com/rpcpool/superbank/commit/cdd78ed23b882c980e4451bab74b5ae5ba007068))
