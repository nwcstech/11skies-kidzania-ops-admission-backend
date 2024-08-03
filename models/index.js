const { Sequelize, DataTypes } = require('sequelize');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const sequelize = new Sequelize(process.env.POSTGRES_DB, process.env.POSTGRES_USER, process.env.POSTGRES_PASSWORD, {
  host: process.env.POSTGRES_HOST,
  dialect: 'postgres',
  dialectOptions: {
    ssl: false, // Disable SSL
  },
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

// Define associations
if (db.admission_check_ins) {
  db.admission_check_ins.hasMany(db.admission_gts_tickets, { foreignKey: 'check_in_id' });
  db.admission_check_ins.hasMany(db.admission_bracelets, { foreignKey: 'check_in_id' });
  db.admission_gts_tickets.belongsTo(db.admission_check_ins, { foreignKey: 'check_in_id' });
  db.admission_bracelets.belongsTo(db.admission_check_ins, { foreignKey: 'check_in_id' });
}

if (db.activity_sessions && db.establishments) {
  db.activity_sessions.belongsTo(db.establishments, { foreignKey: 'establishment_id' });
  db.establishments.hasMany(db.activity_sessions, { foreignKey: 'establishment_id' });
}

module.exports = db;
