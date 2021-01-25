var RawSource = require('webpack-sources/lib/RawSource');
var evaluate = require('eval');
var path = require('path');
var cheerio = require('cheerio');
var url = require('url');
var Promise = require('bluebird');

function StaticSiteGeneratorWebpackPlugin(options) {
  options = options || {};

  this.entry = options.entry;
  this.paths = Array.isArray(options.paths) ? options.paths : [options.paths || '/'];
  this.locals = options.locals;
  this.globals = options.globals;
  this.crawl = Boolean(options.crawl);
}

StaticSiteGeneratorWebpackPlugin.prototype.apply = function(compiler) {
  const self = this;

  addThisCompilationHandler(compiler, function(compilation) {
    addOptimizeAssetsHandler(compilation, function(_, done) {
      var webpackStats = compilation.getStats();
      var webpackStatsJson = webpackStats.toJson({all: false, assets: true}, true);

      try {
        const asset = findAsset(self.entry, compilation, webpackStatsJson);

        if (asset == null) {
          throw new Error('Source file not found: "' + self.entry + '"');
        }

        const assets = getAssetsFromCompilation(compilation, webpackStatsJson);

        const source = asset.source();
        let render = evaluate(source, /* filename: */ self.entry, /* scope: */ self.globals, /* includeGlobals: */ true);

        if (render.hasOwnProperty('default')) {
          render = render['default'];
        }

        if (typeof render !== 'function') {
          throw new Error('Export from "' + self.entry + '" must be a function that returns an HTML string. Is output.libraryTarget in the configuration set to "umd"?');
        }

        renderPaths(self.crawl, self.locals, self.paths, render, assets, webpackStats, compilation)
          .nodeify(done);
      } catch (err) {
        compilation.errors.push(err.stack);
        done();
      }
    });
  });
};

function renderPaths(crawl, userLocals, paths, render, assets, webpackStats, compilation) {
  const renderPromises = paths.map(function(outputPath) {
    const locals = {
      path: outputPath,
      assets: assets,
      webpackStats: webpackStats
    };

    for (var prop in userLocals) {
      if (userLocals.hasOwnProperty(prop)) {
        locals[prop] = userLocals[prop];
      }
    }

    const renderPromise = render.length < 2 ?
      Promise.resolve(render(locals)) :
      Promise.fromNode(render.bind(null, locals));

    return renderPromise
      .then(function(output) {
        const outputByPath = typeof output === 'object' ? output : makeObject(outputPath, output);

        const assetGenerationPromises = Object.keys(outputByPath).map(function(key) {
          const rawSource = outputByPath[key];
          var assetName = pathToAssetName(key);

          if (compilation.assets[assetName]) {
            return;
          }

          compilation.assets[assetName] = new RawSource(rawSource);

          if (crawl) {
            const relativePaths = relativePathsFromHtml({
              source: rawSource,
              path: key
            });

            return renderPaths(crawl, userLocals, relativePaths, render, assets, webpackStats, compilation);
          }
        });

        return Promise.all(assetGenerationPromises);
      })
      .catch(function(err) {
        compilation.errors.push(err.stack);
      });
  });

  return Promise.all(renderPromises);
}

const findAsset = function(src, compilation, webpackStatsJson) {
  if (!src) {
    const chunkNames = Object.keys(webpackStatsJson.assetsByChunkName);

    src = chunkNames[0];
  }

  const asset = compilation.assets[src];

  if (asset) {
    return asset;
  }

  let chunkValue = webpackStatsJson.assetsByChunkName[src];

  if (!chunkValue) {
    return null;
  }
  // Webpack outputs an array for each chunk when using sourcemaps
  if (chunkValue instanceof Array) {
    // Is the main bundle always the first element?
    chunkValue = chunkValue.find(function(filename) {
      return /\.js$/.test(filename);
    });
  }
  return compilation.assets[chunkValue];
};

// Shamelessly stolen from html-webpack-plugin - Thanks @ampedandwired :)
const getAssetsFromCompilation = function(compilation, webpackStatsJson) {
  const assets = {};
  for (let chunk in webpackStatsJson.assetsByChunkName) {
    let chunkValue = webpackStatsJson.assetsByChunkName[chunk];

    // Webpack outputs an array for each chunk when using sourcemaps
    if (chunkValue instanceof Array) {
      // Is the main bundle always the first JS element?
      chunkValue = chunkValue.find(function(filename) {
        return /\.js$/.test(filename);
      });
    }

    if (compilation.options.output.publicPath) {
      chunkValue = compilation.options.output.publicPath + chunkValue;
    }
    assets[chunk] = chunkValue;
  }

  return assets;
};

function pathToAssetName(outputPath) {
  let outputFileName = outputPath.replace(/^(\/|\\)/, ''); // Remove leading slashes for webpack-dev-server

  if (!/\.(html?)$/i.test(outputFileName)) {
    outputFileName = path.join(outputFileName, 'index.html');
  }

  return outputFileName;
}

function makeObject(key, value) {
  const obj = {};
  obj[key] = value;
  return obj;
}

function relativePathsFromHtml(options) {
  const html = options.source;
  const currentPath = options.path;

  const $ = cheerio.load(html);

  const linkHrefs = $('a[href]')
    .map(function(i, el) {
      return $(el).attr('href');
    })
    .get();

  const iframeSrcs = $('iframe[src]')
    .map(function(i, el) {
      return $(el).attr('src');
    })
    .get();

  return []
    .concat(linkHrefs)
    .concat(iframeSrcs)
    .map(function(href) {
      if (href.indexOf('//') === 0) {
        return null
      }

      const parsed = url.parse(href);

      if (parsed.protocol || typeof parsed.path !== 'string') {
        return null;
      }

      return parsed.path.indexOf('/') === 0 ?
        parsed.path :
        url.resolve(currentPath, parsed.path);
    })
    .filter(function(href) {
      return href != null;
    });
}

function addThisCompilationHandler(compiler, callback) {
  compiler.hooks.thisCompilation.tap('static-site-generator-webpack-plugin', callback);
}

function addOptimizeAssetsHandler(compilation, callback) {
  compilation.hooks.optimizeAssets.tapAsync('static-site-generator-webpack-plugin', callback);
}

module.exports = StaticSiteGeneratorWebpackPlugin;
