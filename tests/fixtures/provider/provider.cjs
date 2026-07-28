module.exports.createAdapter = function createAdapter() {
  return {
    name: "custom",
    async validate() {
      return false;
    },
    async deploy() {
      throw new Error("must not deploy after failed validation");
    },
    async health() {
      return false;
    },
    async rollback() {
      throw new Error("must not roll back before deployment");
    },
    async deploymentUrl() {
      return "https://example.invalid";
    },
    async deployedVersion() {
      return "0.0.0";
    },
    async evidence() {
      return { deploymentId: "never", observedAt: "2026-07-28T00:00:00.000Z" };
    }
  };
};
