module.exports = {
  dependency: {
    platforms: {
      kepler: {
        autolink: {
          NuvioMediaProxy: {
            libraryName: 'libNuvioMediaProxy.so',
            linkDynamic: true,
            provider: 'application',
            components: [],
            turbomodules: ['NuvioMediaProxy'],
          },
        },
      },
    },
  },
};
