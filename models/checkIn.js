module.exports = (sequelize, DataTypes) => {
    const CheckIn = sequelize.define('CheckIn', {
      transaction_id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      number_of_kids: {
        type: DataTypes.INTEGER,
        allowNull: false
      },
      kidzo_checked: {
        type: DataTypes.BOOLEAN,
        allowNull: false
      },
      timestamp: {
        type: DataTypes.DATE,
        allowNull: false
      }
    });
  
    return CheckIn;
  };
  