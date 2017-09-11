import { access, writeFile, symlink } from 'fs';
import { join, resolve, basename } from 'path';
import { mkdirp, copy, remove } from 'fs-extra';
import { uniq } from 'lodash';
import * as async from 'async';

import * as cssBuilders from './css-builders';
import { clearCache } from './parse';
import { setOne as setSetting } from './settings';
import { getCustomizations } from './customizations';

const nconf = require.main.require('nconf');
const winston = require.main.require('winston');
const db = require.main.require('./src/database');

export const assetsDir = join(__dirname, `../emoji`);

const linkDirs = (sourceDir: string, destDir: string, callback: NodeBack) => {
  const type = (process.platform === 'win32') ? 'junction' : 'dir';
  symlink(sourceDir, destDir, type, callback);
};

export const tableFile = join(assetsDir, 'table.json');
export const aliasesFile = join(assetsDir, 'aliases.json');
export const asciiFile = join(assetsDir, 'ascii.json');
export const charactersFile = join(assetsDir, 'characters.json');
export const categoriesFile = join(assetsDir, 'categories.json');
export const packsFile = join(assetsDir, 'packs.json');

const pluginData = require.main.require('./src/plugins').data;

export default function build(callback: NodeBack) {
  async.waterfall([
    // get all active plugin paths
    pluginData.getPluginPaths,
    // filter to only emoji packs
    (paths: string[], next: NodeBack) =>
      async.filter(paths, (path, next) => {
        async.some([
          join(path, 'emoji.json'),
          join(path, 'emoji.js'),
        ], (path, next) => {
          access(path, (err) => {
            if (err && err.code !== 'ENOENT') {
              next(err);
            } else {
              next(null, !err);
            }
          });
        }, next);
      }, next),
    // evaluate the emoji definitions
    (paths: string[], next: NodeBack) =>
      async.map(paths, (path, next) => {
        try {
          const pack: EmojiDefinition | AsyncEmojiDefinition = require(join(path, 'emoji'));
          
          if (typeof pack === 'function') {
            pack((err, pack) => next(err, [path, pack]));
          } else {
            next(null, [path, pack]);
          }
        } catch (e) {
          winston.warn('[emoji] error occurred while loading pack', path, e.stack);
          next();
        }
      }, next),
      // clear dirs
    (packs: [string, EmojiDefinition][], next: NodeBack) => {
      // filter out invalid ones
      const filtered = packs.filter(Boolean).filter(([path, pack]) => {
        if (pack && pack.id && pack.name && pack.mode && pack.dictionary) {
          return true;
        }

        winston.warn('[emoji] pack invalid', path);
        return false;
      });

      async.series([
        cb => remove(assetsDir, cb),
        cb => mkdirp(assetsDir, cb),
      ], (err: Error) => next(err, filtered));
    },
    (packs: [string, EmojiDefinition][], next: NodeBack) => {
      getCustomizations((err, custs) => next(err, packs, custs));
    },
    (packs: [string, EmojiDefinition][], customizations: Customizations, next: NodeBack) => {
      const table: MetaData.table = {};
      const aliases: MetaData.aliases = {};
      const ascii: MetaData.ascii = {};
      const characters: MetaData.characters = {};

      const categoriesInfo: MetaData.categories = {};
      const packsInfo: MetaData.packs = [];

      packs.forEach(([, pack]) => {
        packsInfo.push({
          name: pack.name,
          id: pack.id,
          attribution: pack.attribution,
          license: pack.license,
        });

        Object.keys(pack.dictionary).forEach((key) => {
          const name = key.toLowerCase();
          const emoji = pack.dictionary[key];

          if (!table[name]) {
            table[name] = {
              name,
              character: emoji.character,
              image: emoji.image || '',
              pack: pack.id,
              aliases: emoji.aliases || [],
              keywords: emoji.keywords || [],
            };
          }

          if (emoji.character && !characters[emoji.character]) {
            characters[emoji.character] = name;
          }

          if (emoji.aliases) {
            emoji.aliases.forEach((alias) => {
              const a = alias.toLowerCase();
              if (!aliases[a]) {
                aliases[a] = name;
              }
            });
          }

          if (emoji.ascii) {
            emoji.ascii.forEach((str) => {
              if (!ascii[str]) {
                ascii[str] = name;
              }
            });
          }

          const categories = emoji.categories || ['other'];
          categories.forEach((category) => {
            categoriesInfo[category] = categoriesInfo[category] || [];
            categoriesInfo[category].push(name);
          });
        });
      });

      Object.keys(categoriesInfo).forEach((category) => {
        categoriesInfo[category] = uniq(categoriesInfo[category]);
      });

      customizations.emojis.forEach((emoji) => {
        const name = emoji.name.toLowerCase();

        table[name] = {
          name,
          character: '',
          pack: 'customizations',
          keywords: [],
          image: emoji.image,
          aliases: emoji.aliases,
        };

        emoji.aliases.forEach((alias) => {
          const a = alias.toLowerCase();
          if (!aliases[a]) {
            aliases[a] = name;
          }
        });

        emoji.ascii.forEach((str) => {
          if (!ascii[str]) {
            ascii[str] = name;
          }
        });

        categoriesInfo.custom = categoriesInfo.custom || [];
        categoriesInfo.custom.push(name);
      });
      customizations.adjuncts.forEach((adjunct) => {
        const name = adjunct.name;
        if (!table[name]) { return; }

        table[name] = {
          ...table[name],
          aliases: table[name].aliases.concat(adjunct.aliases),
        };

        adjunct.aliases.forEach(alias => aliases[alias] = name);
        adjunct.ascii.forEach(str => ascii[str] = name);
      });

      async.parallel([
        // generate CSS styles and store them
        (cb) => {
          const css = packs.map(([, pack]) => cssBuilders[pack.mode](pack)).join('\n');
          writeFile(
            join(assetsDir, 'styles.css'), 
            `${css}\n.emoji-customizations { display: inline-block; height: 23px; }`,
            { encoding: 'utf8' }, 
            cb,
          );
        },
        // persist metadata to disk
        cb => writeFile(tableFile, JSON.stringify(table), cb),
        cb => writeFile(aliasesFile, JSON.stringify(aliases), cb),
        cb => writeFile(asciiFile, JSON.stringify(ascii), cb),
        cb => writeFile(charactersFile, JSON.stringify(characters), cb),
        cb => writeFile(categoriesFile, JSON.stringify(categoriesInfo), cb),
        cb => writeFile(packsFile, JSON.stringify(packsInfo), cb),
        // handle copying or linking necessary assets
        cb => async.each(packs, ([path, pack]: [string, EmojiDefinition], next) => {
          const dir = join(assetsDir, pack.id);

          if (pack.mode === 'images') {
            linkDirs(resolve(path, pack.images.directory), dir, next);
          } else if (pack.mode === 'sprite') {
            const filename = basename(pack.sprite.file);
            async.series([
              cb => mkdirp(dir, cb),
              cb => copy(resolve(path, pack.sprite.file), join(dir, filename), cb),
            ], next);
          } else { // pack.mode === 'font'
            const fontFiles = [
              pack.font.eot,
              pack.font.svg,
              pack.font.woff,
              pack.font.ttf,
              pack.font.woff2,
            ].filter(Boolean);

            async.series([
              cb => mkdirp(dir, cb),
              cb => async.each(fontFiles, (file, next) => {
                const filename = basename(file);
                copy(resolve(path, file), join(dir, filename), next);
              }, cb),
            ], next);
          }
        }, cb),
        // link customizations to public/uploads/emoji
        cb => linkDirs(
          join(nconf.get('upload_path'), 'emoji'), 
          join(assetsDir, 'customizations'), 
          cb,
        ),
      ], next);
    },
    (results: any, next: NodeBack) => {
      clearCache();
      next();
    },
  ], callback);
}
