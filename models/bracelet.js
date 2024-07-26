module.exports = (sequelize, DataTypes) => {
    const Bracelet = sequelize.define('Bracelet', {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      code: {
        type: DataTypes.STRING,
        allowNull: false
      },
      timestamp: {
        type: DataTypes.DATE,
        allowNull: false
      },
      duplicate: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
      },
      check_in_id: {
        type: DataTypes.UUID,
        references: {
          model: 'CheckIn',
          key: 'transaction_id'
        }
      }
    });
  
    return Bracelet;
  };
  