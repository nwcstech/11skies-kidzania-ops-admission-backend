module.exports = (sequelize, DataTypes) => {
  const FIBConfig = sequelize.define('FIBConfig', {
    hostname: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: false,
    },
    config: {
      type: DataTypes.JSONB,
      allowNull: false,
    },
    updated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    publish_at: {
      type: DataTypes.DATE,
    },
    is_published: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
  }, {
    tableName: 'fib_configs',
    indexes: [
      {
        unique: true,
        fields: ['hostname']
      },
      {
        fields: ['publish_at']
      },
      {
        fields: ['is_published']
      }
    ],
    timestamps: false,
  });

  return FIBConfig;
};