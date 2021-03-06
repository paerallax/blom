/* tslint:disable
 * no-console no-submodule-imports
 * max-func-body-length strict-boolean-expressions
 * promise-function-async
 * */

// import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer'
// import { Store } from 'redux'
import * as path from 'path'
import CleanWebpackPlugin = require('clean-webpack-plugin')
import CompressionWebpackPlugin = require('compression-webpack-plugin')
import CopyWebpackPlugin = require('copy-webpack-plugin')
import CssoWebpackPlugin from 'csso-webpack-plugin'
import ExtractTextPlugin = require('extract-text-webpack-plugin')
import FriendlyErrorsWebpackPlugin = require('friendly-errors-webpack-plugin')
import HtmlWebpackPlugin = require('html-webpack-plugin')
import ProgressBarWebpackPlugin = require('progress-bar-webpack-plugin')
import TsconfigPathsPlugin = require('tsconfig-paths-webpack-plugin')
import UglifyJsPlugin = require('uglifyjs-webpack-plugin')
import VueSSRClientPlugin = require('vue-server-renderer/client-plugin')
import VueSSRServerPlugin = require('vue-server-renderer/server-plugin')
import chalk from 'chalk'
import connectHistoryApiFallback = require('connect-history-api-fallback')
import express = require('express')
import merge = require('webpack-merge')
import nodeExternals = require('webpack-node-externals')
import webpack = require('webpack')
import webpackDevMiddleware = require('webpack-dev-middleware')
import webpackHotMiddleware = require('webpack-hot-middleware')
import { BundleRenderer, createBundleRenderer } from 'vue-server-renderer'
import { Options, Stats } from 'webpack'
import { fs as memfs } from 'memfs'

import {
  assign,
  compact,
  forOwn,
  includes,
  isString,
  isUndefined,
  map,
  noop,
  omit,
  union
} from 'lodash'

import { BlomCompilationError } from './errors'

import { logger } from './logger'

import { readFileAsync } from './utils'

import {
  BlomWebpackDevelopmentServerResolve,
  BlomWebpackProductionServerResolve,
  State
} from './types'

import {
  SSRClientFilename,
  SSRClientPath,
  SSRServerFilename,
  SSRServerPath,
  assetsDirectory,
  compressionTest,
  // condBuild,
  condDevelopment,
  condHMR,
  condInteractive,
  condProduction,
  condWatch,
  context,
  devtool,
  entries,
  externalsWhitelist,
  home,
  host,
  loaderTest,
  nodeEnvSelector,
  outputPath,
  port,
  publicPath,
  sourceMap,
  staticAssets,
  statsOption,
  template,
  typescript,
  uglifyOptions
} from './selectors'

const assetsPath = (state: State, _destination: string) => {
  const destination = path.posix.join(assetsDirectory(state), _destination)

  return condDevelopment(state)
    ? destination.replace(/\[(chunkhash|contenthash|hash)(:\d+)?\]\./, '')
    : destination
}

const watchOptions = () => ({
  aggregateTimeout: 300,
  ignored: /node_modules/,
  poll: 1000
})

const typescriptLoaderConfiguration = (state: State) =>
  compact([
    condProduction(state) && {
      loader: 'babel-loader',
      options: {
        babelrc: false,
        cacheDirectory: true,
        plugins: [require.resolve('@babel/plugin-syntax-dynamic-import')],
        presets: [
          [
            require.resolve('@babel/preset-env'),
            {
              configPath: context(state),
              modules: false,
              useBuiltIns: 'entry',
              loose: true
            }
          ]
        ]
      }
    },
    {
      loader: 'ts-loader',
      options: {
        logLevel: 'error',
        silent: true,
        compiler: typescript(state),
        appendTsSuffixTo: [/\.vue$/i],
        configFile: path.join(context(state), 'tsconfig.json'),
        compilerOptions: {
          downlevelIteration: true,
          importHelpers: true,
          module: 'esnext',
          sourceMap: true,
          target: 'es6'
        }
      }
    }
  ])

const cssLoaderConfigration = (state: State) => {
  const cssLoader: webpack.NewLoader = {
    loader: 'css-loader',
    options: {
      minimize: false,
      sourceMap: sourceMap()
    }
  }

  const postcssLoader: webpack.NewLoader = {
    loader: 'postcss-loader',
    options: {
      sourceMap: sourceMap(),
      config: {
        path: context(state)
      }
    }
  }

  // generate loader string to be used with extract text plugin
  const cssLoaderConfiguration = (
    loader?: string,
    // tslint:disable-next-line no-any
    loaderOptions?: { [name: string]: any }
  ) => {
    const loaders: webpack.NewLoader[] = [cssLoader, postcssLoader]

    if (loader) {
      loaders.push({
        loader: `${loader}-loader`,
        options: assign({}, loaderOptions || {}, {
          sourceMap: sourceMap()
        })
      })
    }

    // Extract CSS when that option is specified
    // (which is the case during production build)
    if (condProduction(state)) {
      return ExtractTextPlugin.extract({
        use: loaders,
        fallback: 'vue-style-loader'
      })
    } else {
      return [{ loader: 'vue-style-loader' }].concat(loaders)
    }
  }

  // https://vue-loader.vuejs.org/en/configurations/extract-css.html
  return {
    css: cssLoaderConfiguration(),
    postcss: cssLoaderConfiguration(),
    less: cssLoaderConfiguration('less'),
    sass: cssLoaderConfiguration('sass', { indentedSyntax: true }),
    scss: cssLoaderConfiguration('sass'),
    stylus: cssLoaderConfiguration('stylus'),
    styl: cssLoaderConfiguration('stylus'),
    ts: typescriptLoaderConfiguration(state)
    // tsx: typescriptLoaderConfiguration(state)
  }
}

const loaderConfiguration = (
  state: State,
  exclude?: string[]
): webpack.Rule[] => {
  const output: webpack.Rule[] = []
  const loaders = cssLoaderConfigration(state)

  forOwn(omit(loaders, exclude || []), (_, key) => {
    const loader = loaders[key]

    output.push({
      test: new RegExp(`\\.${key}$`, 'i'),
      use: loader,
      // TODO: other directories
      include: includes(['ts' /* , 'tsx' */], key)
        ? [path.join(context(state), 'src'), path.join(home(state), 'entries')]
        : undefined
    })
  })

  return output
}

const ruleConfiguration = (state: State): webpack.Rule[] => {
  return union<webpack.Rule>(
    [
      {
        test: f => f === template(state),
        loader: 'mustache-loader',
        options: {
          tiny: true
          // render: templateContext(state)
        }
      },
      {
        test: /\.vue$/i,
        loader: 'vue-loader',
        options: {
          loaders: cssLoaderConfigration(state),
          cssSourceMap: sourceMap(),
          postcss: {
            useConfigFile: false
          },
          hotReload: condHMR(state),
          transformToRequire: {
            video: ['src', 'poster'],
            source: 'src',
            img: 'src',
            image: 'xlink:href'
          }
        }
      }
    ],
    loaderConfiguration(state),
    [
      {
        test: loaderTest(state).image,
        loader: 'url-loader',
        options: {
          limit: 10000,
          name: assetsPath(state, 'images/[name].[hash:7].[ext]')
        }
      },
      {
        test: loaderTest(state).media,
        loader: 'url-loader',
        options: {
          limit: 10000,
          name: assetsPath(state, 'media/[name].[hash:7].[ext]')
        }
      },
      {
        test: loaderTest(state).font,
        loader: 'url-loader',
        options: {
          limit: 10000,
          name: assetsPath(state, 'fonts/[name].[hash:7].[ext]')
        }
      }
    ]
  )
}

// tslint:disable-next-line max-func-body-length
export const webpackBaseConfiguration = (
  state: State
): webpack.Configuration => ({
  watchOptions: watchOptions(),
  output: {
    chunkFilename: assetsPath(state, 'js/[id].[chunkhash].js'),
    devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    filename: assetsPath(state, 'js/[name].[chunkhash].js'),
    path: condProduction(state) ? outputPath(state) : undefined,
    publicPath: publicPath(state)
  },
  context: context(state),
  devtool: devtool(state) as Options.Devtool,
  plugins: compact([
    condProduction(state) &&
      new CleanWebpackPlugin([outputPath(state)], {
        root: context(state),
        verbose: false
      }),
    condProduction(state) &&
      new ExtractTextPlugin({
        filename: assetsPath(state, 'css/[name].[contenthash].css'),
        // Setting the following option to `false` will not extract CSS from
        // codesplit chunks. Their CSS will instead be inserted dynamically
        // with style-loader when the codesplit chunk has been loaded by
        // webpack.  It's currently set to `true` because we are seeing that
        // sourcemaps are included in the codesplit bundle as well when it's
        // `false`, increasing file size:
        // https://github.com/vuejs-templates/webpack/issues/1110
        allChunks: true
      }),
    condProduction(state) && new webpack.HashedModuleIdsPlugin(),
    condProduction(state) && new webpack.optimize.ModuleConcatenationPlugin()
    // TODO: review this
    // condDevelopment(state) &&
    //   new webpack.WatchIgnorePlugin([]),
    // new BundleAnalyzerPlugin({
    //   logLevel: 'error',
    //   openAnalyzer: false,
    //   analyzerMode: 'server',
    //   analyzerHost: host(state),
    //   analyzerPort: port(state) + 1
    // })
  ]),
  module: {
    // TODO: review this
    noParse: /es6-promise\.js$/, // Avoid webpack shimming process
    rules: ruleConfiguration(state)
  },
  resolve: {
    plugins: [
      new TsconfigPathsPlugin({
        silent: false,
        configFile: path.join(context(state), 'tsconfig.json')
      })
    ],
    extensions: ['.ts', '.js', '.vue', '.json'],
    // TODO: sandbox plugin
    modules: [
      path.join(context(state), 'node_modules'),
      path.join(home(state), 'node_modules')
    ]
  },
  resolveLoader: {
    modules: [
      path.join(context(state), 'node_modules'),
      path.join(home(state), 'node_modules')
    ]
  },
  performance: {
    hints: false
  },
  node: {
    // prevent webpack from injecting useless setImmediate polyfill because Vue
    // source contains it (although only uses it if it's native).
    setImmediate: false,
    // prevent webpack from injecting mocks to Node native modules
    // that does not make sense for the client
    dgram: 'empty',
    fs: 'empty',
    net: 'empty',
    tls: 'empty',
    child_process: 'empty'
  },
  stats: statsOption(state)
})

const webpackInteractivePlugins = (state: State): webpack.Plugin[] =>
  compact([
    condInteractive(state) &&
      new ProgressBarWebpackPlugin({
        complete: chalk.green('█'),
        incomplete: chalk.white('█'),
        format: `  :bar ${chalk.green.bold(':percent')} :msg`,
        clear: false
      }),
    condInteractive(state) &&
      new FriendlyErrorsWebpackPlugin({
        clearConsole: true
      })
  ])

const webpackDefinePlugin = (
  state: State,
  vueEnv: 'client' | 'server'
): webpack.Plugin =>
  new webpack.DefinePlugin({
    'process.env': {
      NODE_ENV: JSON.stringify(nodeEnvSelector(state)),
      VUE_ENV: JSON.stringify(vueEnv)
    }
  })

const webpackDevelopmentConfiguration = (state: State): webpack.Configuration =>
  merge(webpackBaseConfiguration(state), {
    entry: {
      main: [entries(state).webpackHotMiddleware, entries(state).client]
    },
    plugins: compact([
      webpackDefinePlugin(state, 'client'),
      condHMR(state) && new webpack.HotModuleReplacementPlugin(),
      condHMR(state) && new webpack.NamedModulesPlugin(),
      condHMR(state) && new webpack.NoEmitOnErrorsPlugin(),
      new HtmlWebpackPlugin({
        template: template(state),
        inject: true,
        chunksSortMode: 'dependency',
        cache: true,
        minify: {
          removeComments: true,
          collapseWhitespace: true,
          removeAttributeQuotes: true
          // more options:
          // https://github.com/kangax/html-minifier#options-quick-reference
        }
      }),
      ...webpackInteractivePlugins(state)
    ])
  })

const webpackProductionConfiguration = (
  state: State
): webpack.Configuration[] => [
  merge(webpackBaseConfiguration(state), {
    entry: {
      main: [entries(state).babelPolyfill, entries(state).server]
    },
    target: 'node',

    // For bundle renderer source map support
    devtool: 'source-map',

    // This tells the server bundle to use Node-style exports
    output: {
      libraryTarget: 'commonjs2'
    },

    // https://webpack.js.org/configuration/externals/#function
    // https://github.com/liady/webpack-node-externals
    // Externalize app dependencies. This makes the server build much faster
    // and generates a smaller bundle file.
    externals: nodeExternals({
      modulesDir: path.join(context(state), 'node_modules'),
      // do not externalize dependencies that need to be processed by webpack.
      // you can add more file types here e.g. raw *.vue files
      // you should also whitelist deps that modifies `global` (e.g. polyfills)
      whitelist: externalsWhitelist(state)
    }),

    // This is the plugin that turns the entire output of the server build
    // into a single JSON file. The default file name will be
    // `vue-ssr-server-bundle.json`
    plugins: compact([
      webpackDefinePlugin(state, 'server'),
      new VueSSRServerPlugin({
        filename: SSRServerFilename(state)
      })
    ])
  }),
  merge(webpackBaseConfiguration(state), {
    entry: {
      main: [entries(state).babelPolyfill, entries(state).client]
    },
    plugins: compact([
      webpackDefinePlugin(state, 'client'),
      new CssoWebpackPlugin(),
      new UglifyJsPlugin({
        parallel: true,
        sourceMap: sourceMap(),
        uglifyOptions: uglifyOptions(state)
      }),
      new webpack.optimize.CommonsChunkPlugin({
        name: 'vendor',
        // any required modules inside node_modules are extracted to vendor
        minChunks: module =>
          module.resource &&
          /\.js$/.test(module.resource) &&
          !/\.(css|less|scss|sass|styl|stylus|vue)$/.test(module.request) &&
          (includes(
            module.resource,
            path.join(context(state), 'node_modules')
          ) ||
            includes(module.resource, path.join(home(state), 'node_modules')))
      }),
      // extract webpack runtime and module manifest to its own file in order to
      // prevent vendor hash from being updated whenever app bundle is updated
      // https://github.com/vuejs-templates/webpack/blob/develop/template/build/webpack.prod.conf.js
      new webpack.optimize.CommonsChunkPlugin({
        name: 'manifest',
        minChunks: Infinity
      }),
      new webpack.optimize.CommonsChunkPlugin({
        name: 'main',
        async: 'vendor-async',
        children: true,
        minChunks: 3
      }),
      (() => {
        const sa = staticAssets(state)

        if (isString(sa)) {
          return new CopyWebpackPlugin([
            {
              from: sa,
              to: path.join(outputPath(state)),
              ignore: ['.*']
            }
          ])
        }
      })(),
      new CompressionWebpackPlugin({
        asset: '[path].gz[query]',
        algorithm: 'gzip',
        test: compressionTest(state),
        threshold: 10240,
        minRatio: 0.8
      }),
      new VueSSRClientPlugin({
        filename: SSRClientFilename(state)
      }),
      ...webpackInteractivePlugins(state)
    ])
  })
]

export const webpackDevelopmentServer = (
  state: State
): BlomWebpackDevelopmentServerResolve => {
  const configuration = webpackDevelopmentConfiguration(state)
  const compiler = webpack(configuration)

  compiler.outputFileSystem = memfs

  const app = express()

  return {
    type: 'development-server',
    app,
    compiler,
    configuration,
    state,
    run: async () => {
      const devMiddleware = webpackDevMiddleware(compiler, {
        publicPath: publicPath(state),
        stats: statsOption(state),
        logLevel: 'silent'
      })

      // TODO: html-webpack-plugin-after-emit
      const hotMiddleware = webpackHotMiddleware(compiler, {
        log: false
      })

      app.use(hotMiddleware)
      app.use(connectHistoryApiFallback())
      app.use(devMiddleware)

      return new Promise<() => Promise<void>>(resolve => {
        devMiddleware.waitUntilValid(() => {
          const server = app.listen({
            host: host(state),
            port: port(state)
          })

          logger.info(`Listening at http://${host(state)}:${port(state)}`)

          const close = (): Promise<void> =>
            Promise.all([
              new Promise(done => {
                server.close(done)
              }),
              new Promise(done => {
                devMiddleware.close(done)
              })
            ]).then(noop)

          resolve(close)
        })
      })
    }
  }
}

const bundleRenderer = async (state: State): Promise<BundleRenderer> =>
  createBundleRenderer(
    JSON.parse(await readFileAsync(SSRServerPath(state), 'utf8')),
    {
      template: await readFileAsync(template(state), 'utf8'),
      clientManifest: JSON.parse(
        await readFileAsync(SSRClientPath(state), 'utf8')
      ),
      inject: true,
      runInNewContext: false,
      basedir: context(state)
    }
  )

const bundleRendererFactory = (
  state: State
): (() => Promise<{
  renderer?: BundleRenderer
  error?: Error | true
}>) => async () =>
  bundleRenderer(state)
    .then(renderer => {
      return {
        error: undefined,
        renderer
      }
    })
    .catch(e => {
      logger.error('Vue Bundle Renderer encountered error(s)', e)

      return {
        error: condWatch(state) ? undefined : e || true,
        renderer: undefined
      }
    })

const webpackHandlerFactory = async (state: State) => {
  /* tslint:disable no-any promise-must-complete */
  let resolve: (value?: any | PromiseLike<any>) => void
  let reject: (reason?: any) => void

  const ready = new Promise((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })

  /* tslint:enable no-any promise-must-complete */

  const references: {
    error?: Error | true
    renderer?: BundleRenderer
  } = {}

  const factory = bundleRendererFactory(state)

  return {
    ready,
    references,
    handler: async (err: Error | undefined, stats: Stats) => {
      if (err) {
        references.error = err || true
      } else {
        const info = stats.toJson()

        if (stats.hasErrors()) {
          if (!condInteractive(state)) {
            logger.error(info.errors)
          }

          if (!condWatch(state)) {
            references.error = new BlomCompilationError(
              'Webpack compiler encountered error(s)',
              stats
            )
          } else {
            references.error = undefined
          }
        } else {
          references.error = undefined
        }

        if (stats.hasWarnings()) {
          if (!condInteractive(state)) {
            logger.warn(info.warnings)
          }
        }
      }

      if (!references.error) {
        assign(references, await factory())
      }

      if (!references.error) {
        resolve()
      } else {
        reject(references.error)
      }
    }
  }
}

export const webpackProductionServer = (
  state: State
): BlomWebpackProductionServerResolve => {
  const configuration = webpackProductionConfiguration(state)
  const compiler = webpack(configuration)

  const app = express()

  return {
    type: 'production-server',
    app,
    compiler,
    configuration,
    state,
    run: async () => {
      const closeCallbacks: ((callback: (() => void)) => void)[] = []

      const { ready, handler, references } = await webpackHandlerFactory(state)

      if (condWatch(state)) {
        const watching = compiler.watch(watchOptions(), handler)

        closeCallbacks.push(watching.close)
      } else {
        compiler.run(handler)
      }

      await ready

      app.use('/', express.static(outputPath(state)))

      app.get('*', (req, res) => {
        res.setHeader('Content-Type', 'text/html')

        const bundleContext = {
          title: 'Blom App',
          url: req.url
        }

        if (!isUndefined(references.renderer)) {
          references.renderer.renderToString(
            bundleContext,
            // tslint:disable-next-line no-any
            (err: any, html) => {
              if (err) {
                if (err.url) {
                  res.redirect(err.url)
                } else if (err.code === 404) {
                  res.status(404).send('Page Not Found')
                } else {
                  // Render Error Page or Redirect
                  res.status(500).send('Internal Server Error')
                  console.error(`error during render : ${req.url}`)
                  console.error(err.stack)
                }
              }

              res.send(html)
            }
          )
        } else if (!isUndefined(references.error)) {
          res.status(500).send('Internal Server Error')
        } else {
          res.status(503).send('The server is currently unavailable')
        }
      })

      const server = app.listen({
        host: host(state),
        port: port(state)
      })

      closeCallbacks.push(server.close)

      return (): Promise<void> =>
        // tslint:disable-next-line no-unnecessary-callback-wrapper
        Promise.all(map(closeCallbacks, cb => new Promise(cb))).then(noop)
    }
  }
}

// export const start = (s: Store<State>) => {
//   const state = s.getState()
//
//   const { compiler, configuration } = webpackCompiler(state)
//
//   if (condDevelopment(state)) {
//   }
//
//   if (condProduction(state)) {
//     return new Promise((resolve, reject) => {
//       compiler.run((err, stats) => {
//         if (err) {
//           reject(err)
//         } else if (stats.hasErrors()) {
//           reject()
//         } else {
//           resolve()
//         }
//       })
//     })
//     .then(async () => {
//     })
//   }
// }
//

// export const build = (s: Store<State>) => {
//   const state = s.getState()
//
//   return Promise.resolve()
//   // const { compiler, configuration } = webpackCompiler(state)
//   //
//   // return new Promise((resolve, reject) => {
//   //   compiler.run((err, stats) => {
//   //     if (err) {
//   //       reject(err)
//   //     } else if (stats.hasErrors()) {
//   //       reject()
//   //     } else {
//   //       resolve()
//   //     }
//   //   })
//   // })
// }
