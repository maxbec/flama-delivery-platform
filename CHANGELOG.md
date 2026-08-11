# Changelog

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
