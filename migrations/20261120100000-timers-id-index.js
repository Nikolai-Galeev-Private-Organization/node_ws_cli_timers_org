module.exports = {
  async up(db) {
    await db.collection("timers").createIndex({ id: 1 }, { unique: true });
  },
  async down(db) {
    await db
      .collection("timers")
      .dropIndex("id_1")
      .catch(() => {});
  },
};
