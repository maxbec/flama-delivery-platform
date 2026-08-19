# Changelog

## [0.5.7](https://github.com/maxbec/flama-delivery-platform/compare/v0.5.6...v0.5.7) (2026-08-19)


### 🐛 Bug Fixes

* **final:** skip consumer .nvmrc setup-node step when file absent ([#51](https://github.com/maxbec/flama-delivery-platform/issues/51)) ([d2b9ec4](https://github.com/maxbec/flama-delivery-platform/commit/d2b9ec436b69fcd7306fcaf01310a984b3971c4a))
* **policy:** bind the platform lock version to the tag at the pinned ref (PRI-890) ([#54](https://github.com/maxbec/flama-delivery-platform/issues/54)) ([afa15b8](https://github.com/maxbec/flama-delivery-platform/commit/afa15b87dcda04e821efb35f227d5f6c310c1512))
* **release:** author the release pull request with the Maxbec App token ([#55](https://github.com/maxbec/flama-delivery-platform/issues/55)) ([87a9115](https://github.com/maxbec/flama-delivery-platform/commit/87a9115b06539b4273c45a3d0bb4418bcca7758c))
* **release:** auto-relabel merged release PR and fix reviver credentials (PRI-894) ([#53](https://github.com/maxbec/flama-delivery-platform/issues/53)) ([7ec7b93](https://github.com/maxbec/flama-delivery-platform/commit/7ec7b9344ba65f8b4ae745df559fe9bb1e3522de))
* **release:** give the release pull request job its Cloudflare Access secrets ([#56](https://github.com/maxbec/flama-delivery-platform/issues/56)) ([70ba739](https://github.com/maxbec/flama-delivery-platform/commit/70ba739b2f06d326c49e3227f4fdd47ee44067f8))

## [0.5.6](https://github.com/maxbec/flama-delivery-platform/compare/v0.5.5...v0.5.6) (2026-08-18)


### 🐛 Bug Fixes

* **auto-merge:** request workflows:write for heads that touch CI ([#47](https://github.com/maxbec/flama-delivery-platform/issues/47)) ([5bf5a79](https://github.com/maxbec/flama-delivery-platform/commit/5bf5a792e19e16b550d68f38e2dab104708ad6a9))
* **final:** set up consumer Node.js before corepack in code mode ([#43](https://github.com/maxbec/flama-delivery-platform/issues/43)) ([fa5f949](https://github.com/maxbec/flama-delivery-platform/commit/fa5f949e2a7c7bef68d80f9a100659ea3628e28f))
* **gates:** guard deployment-mode corepack enable on self-hosted runner ([#46](https://github.com/maxbec/flama-delivery-platform/issues/46)) ([5764805](https://github.com/maxbec/flama-delivery-platform/commit/5764805c7c847c910bc6527a800e01a399644589))
* **gates:** install corepack if missing before enabling it ([#44](https://github.com/maxbec/flama-delivery-platform/issues/44)) ([53b075a](https://github.com/maxbec/flama-delivery-platform/commit/53b075a03cd967a75cddf1ed3319114fa799efa5))
* **gates:** make runs-on a runner-labels input, default ubuntu-latest ([#42](https://github.com/maxbec/flama-delivery-platform/issues/42)) ([2fe4b46](https://github.com/maxbec/flama-delivery-platform/commit/2fe4b4650dd8535c138116bfa94cbe818cc17bdd))
* **release:** let fix commits cut a patch release on 0.x ([#48](https://github.com/maxbec/flama-delivery-platform/issues/48)) ([8fd727b](https://github.com/maxbec/flama-delivery-platform/commit/8fd727b238c5e09e08792b923cd62d28df392944))
* **release:** Node aus .nvmrc pinnen vor corepack enable (PRI-871) ([#45](https://github.com/maxbec/flama-delivery-platform/issues/45)) ([f0b12b9](https://github.com/maxbec/flama-delivery-platform/commit/f0b12b9a96c53ac807460d6017d9336d831f9504))

## [0.5.5](https://github.com/maxbec/flama-delivery-platform/compare/v0.5.4...v0.5.5) (2026-08-16)


### 🐛 Bug Fixes

* **branch-guard:** allow promote/* heads into main on the major profile ([#40](https://github.com/maxbec/flama-delivery-platform/issues/40)) ([3afa212](https://github.com/maxbec/flama-delivery-platform/commit/3afa21216839587656de28d861080935c85d90a4))

## [0.5.4](https://github.com/maxbec/flama-delivery-platform/compare/v0.5.3...v0.5.4) (2026-08-14)


### 🐛 Bug Fixes

* **auto-merge:** arm with the workflow App token so merges trigger push workflows ([#38](https://github.com/maxbec/flama-delivery-platform/issues/38)) ([6594ee0](https://github.com/maxbec/flama-delivery-platform/commit/6594ee0b12a0653a2b0560da04a3b28de7b57674))

## [0.5.3](https://github.com/maxbec/flama-delivery-platform/compare/v0.5.2...v0.5.3) (2026-08-12)


### 🐛 Bug Fixes

* complete delivery trust loop ([f128cf6](https://github.com/maxbec/flama-delivery-platform/commit/f128cf6759c38f777c9bce4ead930b027b405d72))
* complete delivery trust loop ([91cb950](https://github.com/maxbec/flama-delivery-platform/commit/91cb95051eaf1b816a3e4a0177dda9b14370873d))

## [0.5.2](https://github.com/maxbec/flama-delivery-platform/compare/v0.5.1...v0.5.2) (2026-08-12)


### 🐛 Bug Fixes

* **contracts:** let the bootstrap result describe what bootstrap now produces ([cb253f1](https://github.com/maxbec/flama-delivery-platform/commit/cb253f131e338d0d9ed61324586a4813f60343c2))
* **render:** keep consumer release configuration through a migration ([572168f](https://github.com/maxbec/flama-delivery-platform/commit/572168fd4443292341181366e440060293787182))
* **render:** keep consumer release configuration through a migration ([3d99590](https://github.com/maxbec/flama-delivery-platform/commit/3d9959054245b7aa328c789469d5644288ea736f))

## [0.5.1](https://github.com/maxbec/flama-delivery-platform/compare/v0.5.0...v0.5.1) (2026-08-11)


### 🐛 Bug Fixes

* **bootstrap:** keep a migration from corrupting the repositories it migrates ([d4e2163](https://github.com/maxbec/flama-delivery-platform/commit/d4e21635b35c2579dde914f741ae563323c13973))
* **bootstrap:** keep a migration from corrupting the repositories it migrates ([7726ee9](https://github.com/maxbec/flama-delivery-platform/commit/7726ee9011e2492f85db64f74798a7868e533329))

## [0.5.0](https://github.com/maxbec/flama-delivery-platform/compare/v0.4.2...v0.5.0) (2026-08-11)


### ✨ Features

* **policy:** merge a green pull request without waiting for a person ([428744f](https://github.com/maxbec/flama-delivery-platform/commit/428744f4c4ba58b884d5ca90ac1ff8a4ae6eed1e))
* **policy:** merge a green pull request without waiting for a person ([862f7f5](https://github.com/maxbec/flama-delivery-platform/commit/862f7f53bfa6978e715d591ad826b1f20d6f5a8f))

## [0.4.2](https://github.com/maxbec/flama-delivery-platform/compare/v0.4.1...v0.4.2) (2026-08-11)


### 🐛 Bug Fixes

* **policy:** wait for the preflight instead of sampling for it once ([72df9f8](https://github.com/maxbec/flama-delivery-platform/commit/72df9f897f9c8fea80f17dc0690bb94dfe14bac9))
* **policy:** wait for the preflight instead of sampling for it once ([af1e50e](https://github.com/maxbec/flama-delivery-platform/commit/af1e50e34f22d9fc1b241daf351453fb8aafc0de))

## [0.4.1](https://github.com/maxbec/flama-delivery-platform/compare/v0.4.0...v0.4.1) (2026-08-11)


### 🐛 Bug Fixes

* **delivery-ctl:** configure the remote so a checkout can resolve its upstream ([9eb9fcc](https://github.com/maxbec/flama-delivery-platform/commit/9eb9fcc3b8c5a5eb189b845632f00b0d64e84aa3))
* **delivery-ctl:** configure the remote so a checkout can resolve its upstream ([e97f6ca](https://github.com/maxbec/flama-delivery-platform/commit/e97f6caa3ac26f272c44a6b0259354040bed66a9))

## [0.4.0](https://github.com/maxbec/flama-delivery-platform/compare/v0.3.4...v0.4.0) (2026-08-11)


### ✨ Features

* **delivery-ctl:** expose the preflight sweep as its own command ([5dc1544](https://github.com/maxbec/flama-delivery-platform/commit/5dc1544a6aa5243240fb0f23e2fcc33b2a60fb69))
* **delivery-ctl:** expose the preflight sweep as its own command ([c20ddfb](https://github.com/maxbec/flama-delivery-platform/commit/c20ddfbb280c079650a9e138a46159f6dd93cd51))

## [0.3.4](https://github.com/maxbec/flama-delivery-platform/compare/v0.3.3...v0.3.4) (2026-08-11)


### 🐛 Bug Fixes

* **delivery-ctl:** settle a child on drained output, and enforce the ceiling ([37a7953](https://github.com/maxbec/flama-delivery-platform/commit/37a7953fff6cdfe27febadcbde6ad4add47403c5))
* **delivery-ctl:** settle a child on drained output, and enforce the ceiling ([819ba7b](https://github.com/maxbec/flama-delivery-platform/commit/819ba7b98b05161e301d10dfc37845eb97230078))

## [0.3.3](https://github.com/maxbec/flama-delivery-platform/compare/v0.3.2...v0.3.3) (2026-08-11)


### 🐛 Bug Fixes

* **delivery-ctl:** bound a preflight pass by wall-clock, not head count ([7b609d4](https://github.com/maxbec/flama-delivery-platform/commit/7b609d407395305eeb41f869fc2bccd35e58443d))
* **delivery-ctl:** bound a preflight pass by wall-clock, not head count ([b82005d](https://github.com/maxbec/flama-delivery-platform/commit/b82005dba86f45def8aa48728145a6662da465e1))
* **delivery-ctl:** cap a head's delivery commands at the pass's remaining budget ([532bff8](https://github.com/maxbec/flama-delivery-platform/commit/532bff876bc3e07caa15cd8136c10174f6b22b6d))

## [0.3.2](https://github.com/maxbec/flama-delivery-platform/compare/v0.3.1...v0.3.2) (2026-08-10)


### 🐛 Bug Fixes

* **delivery-ctl:** give git HOME, which worktree add needs to report success ([10db0d2](https://github.com/maxbec/flama-delivery-platform/commit/10db0d28cb2deac9a54bf89c4c8cca8ab12079fa))
* **delivery-ctl:** give git HOME, which worktree add needs to report success ([2b11bdc](https://github.com/maxbec/flama-delivery-platform/commit/2b11bdcbf7471d73720ed355a9b2acb9b8dc5789))

## [0.3.1](https://github.com/maxbec/flama-delivery-platform/compare/v0.3.0...v0.3.1) (2026-08-10)


### 🐛 Bug Fixes

* **delivery-ctl:** decide preflight scope at the head, not the default branch ([0b298a2](https://github.com/maxbec/flama-delivery-platform/commit/0b298a2f82171b9fa090eaadf6220b2d329a421f))
* **delivery-ctl:** decide preflight scope at the head, not the default branch ([6594fc5](https://github.com/maxbec/flama-delivery-platform/commit/6594fc5c347ee0cd46127778b0674dbaae414f9b))

## [0.3.0](https://github.com/maxbec/flama-delivery-platform/compare/v0.2.1...v0.3.0) (2026-08-10)


### ✨ Features

* **controller:** publish missing preflights on the idle tick ([1af4ac3](https://github.com/maxbec/flama-delivery-platform/commit/1af4ac31d64eac7636f5f129c44be8d2198a35a1))
* **controller:** publish missing preflights on the idle tick ([1e4f3ba](https://github.com/maxbec/flama-delivery-platform/commit/1e4f3ba43e386246b794010e1295be0750c4a7fa))
* **delivery-ctl:** compose the preflight chain into a publishable check ([507bab8](https://github.com/maxbec/flama-delivery-platform/commit/507bab8ebceea5a9b39890d9d8d51b3537c036e2))
* **delivery-ctl:** compose the preflight chain into a publishable check ([06783ad](https://github.com/maxbec/flama-delivery-platform/commit/06783ad51ffd10814e0d502cbe25fa82f79ee37f))
* **delivery-ctl:** mint the App installation token preflight publication needs ([4e171a7](https://github.com/maxbec/flama-delivery-platform/commit/4e171a7b18b3d0d8a6aca9856d74f20f009a94b7))
* **delivery-ctl:** mint the App installation token preflight publication needs ([0ac90d4](https://github.com/maxbec/flama-delivery-platform/commit/0ac90d4e2bef1c588a29d9ef77c3151bdfa87a97))
* **delivery-ctl:** provide the clean checkout preflight requires ([4d80683](https://github.com/maxbec/flama-delivery-platform/commit/4d80683cd866e7b7d142ea2f32bcd80a7ad4262e))
* **delivery-ctl:** sweep open heads and publish the preflights they lack ([023c7a5](https://github.com/maxbec/flama-delivery-platform/commit/023c7a5da8cecfdc9bb6fa887a4f497015af6c42))
* **delivery-ctl:** sweep open heads and publish the preflights they lack ([adcbc11](https://github.com/maxbec/flama-delivery-platform/commit/adcbc114b4df72d41935a850c7a1141b52b2a036))

## [0.2.1](https://github.com/maxbec/flama-delivery-platform/compare/v0.2.0...v0.2.1) (2026-08-10)


### 🐛 Bug Fixes

* **controller:** read the skill assignment from the identity, not a board route ([70471c0](https://github.com/maxbec/flama-delivery-platform/commit/70471c0ccde20a5c0a5c0359ced6ff7165d7e3c8))
* **controller:** read the skill assignment from the identity, not a board route ([5a98f85](https://github.com/maxbec/flama-delivery-platform/commit/5a98f85efa1728aed1b6ca353ea8906b42f97a44))
* **release:** derive the platform version instead of restating it ([8142c4a](https://github.com/maxbec/flama-delivery-platform/commit/8142c4a02aa67a7eba15a0405139c39893a2f13e))

## [0.2.0](https://github.com/maxbec/flama-delivery-platform/compare/v0.1.0...v0.2.0) (2026-08-09)


### ✨ Features

* **ci:** cut releases for the platform so consumers can read what changed ([8d292a8](https://github.com/maxbec/flama-delivery-platform/commit/8d292a8f77ec8f95940ee71c3edd67c2328cbb2f))
* **ci:** cut releases for the platform so consumers can read what changed ([e525b79](https://github.com/maxbec/flama-delivery-platform/commit/e525b79ef9050c682f20a212b5f0d8124a09706e))
