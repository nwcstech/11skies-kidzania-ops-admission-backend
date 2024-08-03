module.exports = (sequelize, DataTypes) => {
  const ActivitySession = sequelize.define('activity_sessions', {
      id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true
      },
      establishment_id: {
          type: DataTypes.STRING(255),
          allowNull: false
      },
      activity_name: {
          type: DataTypes.STRING(255),
          allowNull: false
      },
      start_time: {
          type: DataTypes.DATE,
          allowNull: false
      },
      end_time: {
          type: DataTypes.DATE,
          allowNull: true
      },
      status: {
          type: DataTypes.STRING(20),
          allowNull: false,
          defaultValue: 'active'
      },
      guests: {
          type: DataTypes.JSONB,
          allowNull: true
      },
      created_at: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: DataTypes.NOW
      },
      updated_at: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: DataTypes.NOW
      }
  }, {
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at'
  });

  return ActivitySession;
};