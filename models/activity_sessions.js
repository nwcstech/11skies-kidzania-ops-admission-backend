module.exports = (sequelize, DataTypes) => {
    const ActivitySession = sequelize.define('activity_sessions', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      establishment_id: {
        type: DataTypes.STRING,
        allowNull: false
      },
      activity_name: {
        type: DataTypes.STRING,
        allowNull: false
      },
      start_time: {
        type: DataTypes.DATE,
        allowNull: false
      },
      end_time: DataTypes.DATE,
      status: {
        type: DataTypes.ENUM('active', 'completed'),
        defaultValue: 'active'
      },
      guests: DataTypes.JSONB
    });
  
    return ActivitySession;
  };