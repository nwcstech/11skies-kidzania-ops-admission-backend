const { Sequelize, DataTypes } = require('sequelize');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const sequelize = new Sequelize(process.env.POSTGRES_DB, process.env.POSTGRES_USER, process.env.POSTGRES_PASSWORD, {
  host: process.env.POSTGRES_HOST,
  dialect: 'postgres',
  protocol: 'postgres',
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false
    }
  }
});

const db = {};

db.Sequelize = Sequelize;
db.sequelize = sequelize;

const modelsDirectory = __dirname;

fs.readdirSync(modelsDirectory)
  .filter(file => {
    return file.indexOf('.') !== 0 && file !== 'index.js' && file.slice(-3) === '.js';
  })
  .forEach(file => {
    const model = require(path.join(modelsDirectory, file))(sequelize, DataTypes);
    db[model.name] = model;
  });

// Define associations here if necessary
db.CheckIn.hasMany(db.GtsTicket, { foreignKey: 'check_in_id' });
db.CheckIn.hasMany(db.Bracelet, { foreignKey: 'check_in_id' });
db.GtsTicket.belongsTo(db.CheckIn, { foreignKey: 'check_in_id' });
db.Bracelet.belongsTo(db.CheckIn, { foreignKey: 'check_in_id' });

module.exports = db;
