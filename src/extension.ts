import * as vscode from 'vscode';
import { basename, dirname, join, normalize, relative, resolve } from 'path';
import { existsSync, readFile, writeFileSync } from 'fs';
const fsp = require('fs').promises;
import {
  CompletionItemProvider,
  TextDocument,
  Position,
  CancellationToken,
  CompletionContext,
  workspace,
  CompletionItem,
  CompletionItemKind,
  Uri,
} from 'vscode';
import { NoteRefsTreeDataProvider } from './treeViewReferences';
import { debug } from 'util';
import { create } from 'domain';

const workspaceFilenameConvention = (): string | undefined => {
  let cfg = vscode.workspace.getConfiguration('vscodeMarkdownNotes');
  return cfg.get('workspaceFilenameConvention');
};

const useUniqueFilenames = (): boolean => {
  return workspaceFilenameConvention() == 'uniqueFilenames';
};

const useRelativePaths = (): boolean => {
  return workspaceFilenameConvention() == 'relativePaths';
};

const createNoteOnGoToDefinitionWhenMissing = (): boolean => {
  let cfg = vscode.workspace.getConfiguration('vscodeMarkdownNotes');
  return !!cfg.get('createNoteOnGoToDefinitionWhenMissing');
};

function filenameForConvention(uri: Uri, fromDocument: TextDocument): string {
  if (useUniqueFilenames()) {
    return basename(uri.path);
  } else {
    let toPath = uri.path;
    let fromDir = dirname(fromDocument.uri.path.toString());
    let rel = normalize(relative(fromDir, toPath));
    return rel;
  }
}

class WorkspaceTagList {
  static TAG_WORD_SET = new Set();
  static STARTED_INIT = false;
  static COMPLETED_INIT = false;

  static async initSet() {
    if (this.STARTED_INIT) {
      return;
    }
    this.STARTED_INIT = true;
    let files = (await workspace.findFiles('**/*'))
      .filter(
        // TODO: parameterize extensions. Add $ to end?
        (f) => f.scheme == 'file' && f.path.match(/\.(md|markdown)/i)
      )
      .map((f) => {
        // read file, get all words beginning with #, add to Set
        readFile(f.path, (err, data) => {
          let allWords = (data || '').toString().split(/\s/);
          let tags = allWords.filter((w) => w.match(TAG_REGEX_WITH_ANCHORS));
          tags.map((t) => this.TAG_WORD_SET.add(t));
        });
      });
    this.COMPLETED_INIT = true;
  }
}

export class ReferenceSearch {
  // TODO/ FIXME: I wonder if instead of this just-in-time search through all the files,
  // we should instead build the search index for all Tags and WikiLinks once on-boot
  // and then just look in the index for the locations.
  // In that case, we would need to implement some sort of change watcher,
  // to know if our index needs to be updated.
  // This is pretty brute force as it is.
  //
  // static TAG_WORD_SET = new Set();
  // static STARTED_INIT = false;
  // static COMPLETED_INIT = false;

  static rangesForWordInDocumentData = (
    queryWord: string | null,
    data: string
  ): Array<vscode.Range> => {
    let ranges: Array<vscode.Range> = [];
    if (!queryWord) {
      return [];
    }
    let lines = data.split(/[\r\n]/);
    lines.map((line, lineNum) => {
      let charNum = 0;
      // https://stackoverflow.com/questions/17726904/javascript-splitting-a-string-yet-preserving-the-spaces
      let words = line.split(/(\S+\s+)/);
      words.map((word) => {
        // console.log(`word: ${word} charNum: ${charNum}`);
        let spacesBefore = word.length - word.trimLeft().length;
        let trimmed = word.trim();
        if (trimmed == queryWord) {
          let r = new vscode.Range(
            new vscode.Position(lineNum, charNum + spacesBefore),
            // I thought we had to sub 1 to get the zero-based index of the last char of this word:
            // new vscode.Position(lineNum, charNum + spacesBefore + trimmed.length - 1)
            // but the highlighting is off if we do that ¯\_(ツ)_/¯
            new vscode.Position(lineNum, charNum + spacesBefore + trimmed.length)
          );
          ranges.push(r);
        }
        charNum += word.length;
      });
    });
    return ranges;
  };

  static async search(contextWord: ContextWord): Promise<vscode.Location[]> {
    let locations: vscode.Location[] = [];
    let query: string;
    if (contextWord.type == ContextWordType.Tag) {
      query = `#${contextWord.word}`;
    } else if ((contextWord.type = ContextWordType.WikiLink)) {
      query = `[[${basename(contextWord.word)}]]`;
    } else {
      return [];
    }
    // console.log(`query: ${query}`);
    let files = (await workspace.findFiles('**/*')).filter(
      // TODO: parameterize extensions. Add $ to end?
      (f) => f.scheme == 'file' && f.path.match(/\.(md|markdown)/i)
    );
    let paths = files.map((f) => f.path);
    let fileBuffers = await Promise.all(paths.map((p) => fsp.readFile(p)));
    fileBuffers.map((data, i) => {
      let path = files[i].path;
      // console.debug('--------------------');
      // console.log(path);
      // console.log(`${data}`.split(/\n/)[0]);
      let ranges = this.rangesForWordInDocumentData(query, `${data}`);
      ranges.map((r) => {
        let loc = new vscode.Location(Uri.file(path), r);
        locations.push(loc);
      });
    });

    // console.log(locations);
    return locations;
  }
}

enum ContextWordType {
  Null, // 0
  WikiLink, // 1
  Tag, // 2
}

interface ContextWord {
  type: ContextWordType;
  word: string;
  hasExtension: boolean | null;
  range: vscode.Range | undefined;
}

const debugContextWord = (contextWord: ContextWord) => {
  const { type, word, hasExtension, range } = contextWord;
  console.debug({
    type: ContextWordType[contextWord.type],
    word: contextWord.word,
    hasExtension: contextWord.hasExtension,
    range: contextWord.range,
  });
};

const NULL_CONTEXT_WORD = {
  type: ContextWordType.Null,
  word: '',
  hasExtension: null,
  range: undefined,
};
const TAG_REGEX___NO_ANCHORS = /\#[\w\-\_]+/i; // used to match tags that appear within lines
const TAG_REGEX_WITH_ANCHORS = /^\#[\w\-\_]+$/i; // used to match entire words
const WIKI_LINK_REGEX = /\[\[[\w\.\-\_\/\\]+/i; // [[wiki-link-regex
const MARKDOWN_WORD_PATTERN_OVERRIDE = /([\#\.\/\\\w_]+)/; // had to add [".", "/", "\"] to get relative path completion working and ["#"] to get tag completion working

function getContextWord(document: TextDocument, position: Position): ContextWord {
  let contextWord: string;
  let regex: RegExp;
  let range: vscode.Range | undefined;

  // #tag regexp
  regex = TAG_REGEX___NO_ANCHORS;
  range = document.getWordRangeAtPosition(position, regex);
  if (range) {
    // here we do nothing to modify the range because the replacements
    // will include the # character, so we want to keep the leading #
    contextWord = document.getText(range);
    if (contextWord) {
      return {
        type: ContextWordType.Tag,
        word: contextWord.replace(/^\#+/, ''),
        hasExtension: null,
        range: range,
      };
    }
  }

  regex = WIKI_LINK_REGEX;
  range = document.getWordRangeAtPosition(position, regex);
  if (range) {
    // account for the (exactly) 2 [[  chars at beginning of the match
    // since our replacement words do not contain [[ chars
    let s = new vscode.Position(range.start.line, range.start.character + 2);
    // keep the end
    let r = new vscode.Range(s, range.end);
    contextWord = document.getText(r);
    if (contextWord) {
      return {
        type: ContextWordType.WikiLink,
        word: contextWord, // .replace(/^\[+/, ''),
        // TODO: parameterize extensions. Add $ to end?
        hasExtension: !!contextWord.match(/\.(md|markdown)/i),
        range: r, // range,
      };
    }
  }

  return NULL_CONTEXT_WORD;
}

// perhaps there is a race condition in the setting of markdown wordPattern?
// ???????????????????????????????????? 🧐
class MarkdownFileCompletionItemProvider implements CompletionItemProvider {
  public async provideCompletionItems(
    document: TextDocument,
    position: Position,
    _token: CancellationToken,
    context: CompletionContext
  ) {
    const contextWord = getContextWord(document, position);
    // console.debug(
    //   `contextWord: '${contextWord.word}' start: (${contextWord.range?.start.line}, ${contextWord.range?.start.character}) end: (${contextWord.range?.end.line}, ${contextWord.range?.end.character})  context: (${position.line}, ${position.character})`
    // );
    // console.debug(`provideCompletionItems ${ContextWordType[contextWord.type]}`);
    let items = [];
    switch (contextWord.type) {
      case ContextWordType.Null:
        return [];
        break;
      case ContextWordType.Tag:
        // console.debug(`ContextWordType.Tag`);
        // console.debug(
        //   `contextWord.word: ${contextWord.word} TAG_WORD_SET: ${Array.from(
        //     WorkspaceTagList.TAG_WORD_SET
        //   )}`
        // );
        items = Array.from(WorkspaceTagList.TAG_WORD_SET).map((t) => {
          let kind = CompletionItemKind.File;
          let label = `${t}`; // cast to a string
          let item = new CompletionItem(label, kind);
          if (contextWord && contextWord.range) {
            item.range = contextWord.range;
          }
          return item;
        });
        return items;
        break;
      case ContextWordType.WikiLink:
        let files = (await workspace.findFiles('**/*')).filter(
          // TODO: parameterize extensions. Add $ to end?
          (f) => f.scheme == 'file' && f.path.match(/\.(md|markdown)/i)
        );
        items = files.map((f) => {
          let kind = CompletionItemKind.File;
          let label = filenameForConvention(f, document);
          let item = new CompletionItem(label, kind);
          if (contextWord && contextWord.range) {
            item.range = contextWord.range;
          }
          return item;
        });
        return items;
        break;
      default:
        return [];
        break;
    }
  }
}

// TODO: read this!
// https://stackoverflow.com/questions/54285472/vscode-how-to-automatically-jump-to-proper-definition
class MarkdownDefinitionProvider implements vscode.DefinitionProvider {
  public async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ) {
    // console.debug('provideDefinition');

    const contextWord = getContextWord(document, position);
    // debugContextWord(contextWord);
    if (contextWord.type != ContextWordType.WikiLink) {
      // console.debug('getContextWord was not WikiLink');
      return [];
    }
    if (!contextWord.hasExtension) {
      // console.debug('getContextWord does not have file extension');
      return [];
    }

    // TODO: parameterize extensions. return if we don't have a filename and we require extensions
    // const markdownFileRegex = /[\w\.\-\_\/\\]+\.(md|markdown)/i;
    const selectedWord = contextWord.word;
    // console.debug('selectedWord', selectedWord);
    let files: Array<Uri> = [];
    // selectedWord might be either:
    // a basename for a unique file in the workspace
    // or, a relative path to a file
    // Since, selectedWord is just a string of text from a document,
    // there is no guarantee useUniqueFilenames will tell us
    // it is not a relative path.
    // However, only check for basenames in the entire project if:
    if (useUniqueFilenames()) {
      const filename = selectedWord;
      // there should be exactly 1 file with name = selectedWord
      files = (await workspace.findFiles('**/*')).filter((f) => {
        return basename(f.path) == filename;
      });
    }
    // If we did not find any files in the workspace,
    // see if a file exists at the relative path:
    if (files.length == 0) {
      const relativePath = selectedWord;
      let fromDir = dirname(document.uri.path.toString());
      const absPath = resolve(fromDir, relativePath);
      if (existsSync(absPath)) {
        const f = Uri.file(absPath);
        files.push(f);
      }
    }

    // else, create the file
    if (files.length == 0) {
      const path = MarkdownDefinitionProvider.createMissingNote(contextWord);
      if (path !== undefined) {
        files.push(vscode.Uri.parse(`file://${path}`));
      }
    }

    const p = new vscode.Position(0, 0);
    return files.map((f) => new vscode.Location(f, p));
  }

  static createMissingNote = (contextWord: ContextWord): string | undefined => {
    // don't create new files if contextWord is a Tag
    if (contextWord.type != ContextWordType.WikiLink) {
      return;
    }
    let cfg = vscode.workspace.getConfiguration('vscodeMarkdownNotes');
    if (!createNoteOnGoToDefinitionWhenMissing()) {
      return;
    }
    const filename = vscode.window.activeTextEditor?.document.fileName;
    if (filename !== undefined) {
      if (!useUniqueFilenames()) {
        vscode.window.showWarningMessage(
          `createNoteOnGoToDefinitionWhenMissing only works when vscodeMarkdownNotes.workspaceFilenameConvention = 'uniqueFilenames'`
        );
        return;
      }
      // add an extension if one does not exist
      let mdFilename = contextWord.word.match(/\.(md|markdown)$/i)
        ? contextWord.word
        : `${contextWord.word}.md`;
      // by default, create new note in same dir as the current document
      // TODO: could convert this to an option (to, eg, create in workspace root)
      const path = `${dirname(filename)}/${mdFilename}`;
      const title = titleCaseFilename(contextWord.word);
      writeFileSync(path, `# ${title}\n\n`);
      return path;
    }
  };
}

const capitalize = (word: string): string => {
  if (!word) {
    return word;
  }
  return `${word[0].toUpperCase()}${word.slice(1)}`;
};

export const titleCase = (sentence: string): string => {
  if (!sentence) {
    return sentence;
  }
  const chicagoStyleNoCap = `
a aboard about above across after against along amid among an and anti around as at before behind
below beneath beside besides between beyond but by concerning considering despite down during except
excepting excluding following for from in inside into like minus near of off on onto opposite or
outside over past per plus regarding round save since so than the through to toward towards under
underneath unlike until up upon versus via with within without yet
  `.split(/\s/);
  let words = sentence.split(/\s/);
  return words
    .map((word, i) => {
      if (i == 0 || i == words.length - 1) {
        return capitalize(word);
      } else if (chicagoStyleNoCap.includes(word.toLocaleLowerCase())) {
        return word;
      } else {
        return capitalize(word);
      }
    })
    .join(' ');
};

export const titleCaseFilename = (filename: string): string => {
  if (!filename) {
    return filename;
  }
  return titleCase(
    filename
      .replace(/\.(md|markdown)$/, '')
      .replace(/[-_]/gi, ' ')
      .replace(/\s+/, ' ')
  );
};

class MarkdownReferenceProvider implements vscode.ReferenceProvider {
  public provideReferences(
    document: TextDocument,
    position: Position,
    context: vscode.ReferenceContext,
    token: CancellationToken
  ): vscode.ProviderResult<vscode.Location[]> {
    // console.debug('MarkdownReferenceProvider.provideReferences');
    const contextWord = getContextWord(document, position);
    // debugContextWord(contextWord);
    return ReferenceSearch.search(contextWord);
  }
}

function newNote(context: vscode.ExtensionContext) {
  // console.debug('newNote');
  const inputBoxPromise = vscode.window.showInputBox({
    prompt:
      "Enter a 'Title Case Name' to create `title-case-name.md` with '# Title Case Name' at the top.",
    value: '',
  });

  let workspaceUri = '';
  if (vscode.workspace.workspaceFolders) {
    workspaceUri = vscode.workspace.workspaceFolders[0].uri.path.toString();
  }

  inputBoxPromise.then(
    (noteName) => {
      if (noteName == null || !noteName || noteName.replace(/\s+/g, '') == '') {
        // console.debug('Abort: noteName was empty.');
        return false;
      }

      const filename =
        noteName
          .replace(/\W+/gi, '-') // non-words to hyphens
          .toLowerCase() // lower
          .replace(/-*$/, '') + '.md'; // removing trailing '-' chars, add extension
      const filepath = join(workspaceUri, filename);

      const fileAlreadyExists = existsSync(filepath);
      // create the file if it does not exists
      if (!fileAlreadyExists) {
        const contents = `# ${noteName}\n\n`;
        writeFileSync(filepath, contents);
      }

      // open the file:
      vscode.window
        .showTextDocument(vscode.Uri.file(filepath), {
          preserveFocus: false,
          preview: false,
        })
        .then(() => {
          // if we created a new file, hop to line #3
          if (!fileAlreadyExists) {
            let editor = vscode.window.activeTextEditor;
            if (editor) {
              const lineNumber = 3;
              let range = editor.document.lineAt(lineNumber - 1).range;
              editor.selection = new vscode.Selection(range.start, range.end);
              editor.revealRange(range);
            }
          }
        });
    },
    (err) => {
      vscode.window.showErrorMessage('Error creating new note.');
      // console.error(err);
    }
  );
}

const overrideMarkdownWordPattern = () => {
  // console.debug('overrideMarkdownWordPattern');
  vscode.languages.setLanguageConfiguration('markdown', {
    wordPattern: MARKDOWN_WORD_PATTERN_OVERRIDE,
  });
};

export function activate(context: vscode.ExtensionContext) {
  // console.debug('vscode-markdown-notes.activate');
  const md = { scheme: 'file', language: 'markdown' };
  overrideMarkdownWordPattern(); // still nec to get ../ to trigger suggestions in `relativePaths` mode

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(md, new MarkdownFileCompletionItemProvider())
  );
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(md, new MarkdownDefinitionProvider())
  );

  context.subscriptions.push(
    vscode.languages.registerReferenceProvider(md, new MarkdownReferenceProvider())
  );

  let newNoteDisposable = vscode.commands.registerCommand('vscodeMarkdownNotes.newNote', newNote);
  context.subscriptions.push(newNoteDisposable);

  // parse the tags from every file in the workspace
  // console.log(`WorkspaceTagList.STARTED_INIT.1: ${WorkspaceTagList.STARTED_INIT}`);
  WorkspaceTagList.initSet();
  // console.log(`WorkspaceTagList.STARTED_INIT.2: ${WorkspaceTagList.STARTED_INIT}`);

  const treeView = vscode.window.createTreeView('vscodeMarkdownNotesReferences', {
    treeDataProvider: new NoteRefsTreeDataProvider(vscode.workspace.rootPath || null),
  });
}
