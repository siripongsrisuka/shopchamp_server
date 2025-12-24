module.exports = {
    env: {
      // es6: true,
      es2017: true, // to unterstand "async/await"
      node: true,
    },
    parserOptions: {
      // ecmaVersion: 2018,
      ecmaVersion: 2020, // to understand "spread/rest","optional chaining" of object
      sourceType: "module",
      ecmaFeatures: {
        jsx: true,
      }
    },
  };

// module.exports = { // more over waring  eg. not proper space, single quote
//   root: true,
//   env: {
//     es6: true,
//     node: true,
//   },
//   extends: [
//     "eslint:recommended",
//     "google",
//   ],
//   rules: {
//     quotes: ["error", "double"],
//   },
// };
