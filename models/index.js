const { Sequelize, DataTypes } = require('sequelize');
require('dotenv').config();

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

db.CheckIn = require('./checkin')(sequelize, DataTypes);
db.GtsTicket = require('./gtsticket')(sequelize, DataTypes);
db.Bracelet = require('./bracelet')(sequelize, DataTypes);

db.CheckIn.hasMany(db.GtsTicket, { foreignKey: 'check_in_id' });
db.CheckIn.hasMany(db.Bracelet, { foreignKey: 'check_in_id' });
db.GtsTicket.belongsTo(db.CheckIn, { foreignKey: 'check_in_id' });
db.Bracelet.belongsTo(db.CheckIn, { foreignKey: 'check_in_id' });

module.exports = db;