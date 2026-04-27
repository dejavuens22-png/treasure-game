const TREASURE_TYPES = [
  { type: "common", min: 10, max: 100 },
  { type: "rare", min: 101, max: 1000 },
  { type: "epic", min: 1001, max: 10000 },
  { type: "legendary", min: 10001, max: 100000 },
];

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const resolveTreasureTypeByValue = (value) => {
  if (value >= 10 && value <= 100) return "common";
  if (value >= 101 && value <= 1000) return "rare";
  if (value >= 1001 && value <= 10000) return "epic";
  return "legendary";
};

const generateTreasureReward = () => {
  const value = randomInt(10, 100000);
  return {
    type: resolveTreasureTypeByValue(value),
    value,
  };
};

module.exports = {
  generateTreasureReward,
  TREASURE_TYPES,
};
