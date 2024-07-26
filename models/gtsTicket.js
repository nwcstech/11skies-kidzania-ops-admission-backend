module.exports = (sequelize, DataTypes) => {
  const GtsTicket = sequelize.define('admission_gts_tickets', {
    code: DataTypes.STRING,
    check_in_id: {
      type: DataTypes.UUID,
      references: {
        model: 'admission_check_ins',
        key: 'transaction_id'
      }
    },
    duplicate: DataTypes.BOOLEAN,
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },
    updated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },
    deleted_at: DataTypes.DATE
  }, {
    timestamps: true,
    paranoid: true,
    updatedAt: 'updated_at',
    createdAt: 'created_at',
    deletedAt: 'deleted_at'
  });

  return GtsTicket;
};
