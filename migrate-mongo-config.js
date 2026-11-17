require("dotenv").config();

const config = {
  mongodb: {
    url: process.env.DB_URI || "mongodb://localhost:27017",

    databaseName: "sample_mflix",

    options: {},
  },

  migrationsDir: "migrations",

  changelogCollectionName: "changelog",

  migrationFileExtension: ".js",

  moduleSystem: "commonjs",
};

module.exports = config;
