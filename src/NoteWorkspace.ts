import * as vscode from 'vscode';
import { basename, dirname, join, normalize, relative, resolve } from 'path';
import { existsSync, readFile, writeFileSync } from 'fs';

export const foo = () => {
  return 1;
};

enum NoteCompletionConvention {
  rawFilename = 'rawFilename',
  noExtension = 'noExtension',
  toSpaces = 'toSpaces',
}
enum WorkspaceFilenameConvention {
  uniqueFilenames = 'uniqueFilenames',
  relativePaths = 'relativePaths',
}
enum SlugifyCharacter {
  dash = '-',
  underscore = '_',
  none = 'NONE',
}

type Config = {
  createNoteOnGoToDefinitionWhenMissing: boolean;
  defaultFileExtension: string;
  noteCompletionConvention: NoteCompletionConvention;
  slugifyCharacter: SlugifyCharacter;
  workspaceFilenameConvention: WorkspaceFilenameConvention;
};

// This class contains:
// 1. an interface to some of the basic user configurable settings or this extension
// 2. command for creating a New Note
// 3. some other bootstrapping
export class NoteWorkspace {
  // Defining these as strings now, and then compiling them with accessor methods.
  // This will allow us to potentially expose these as settings.
  static _rxTagNoAnchors = '\\#[\\w\\-\\_]+'; // used to match tags that appear within lines
  static _rxTagWithAnchors = '^\\#[\\w\\-\\_]+$'; // used to match entire words
  static _rxWikiLink = '\\[\\[[^\\]]+\\]\\]'; // [[wiki-link-regex]]
  static _rxMarkdownWordPattern = '([\\_\\w\\#\\.\\/\\\\]+)'; // had to add [".", "/", "\"] to get relative path completion working and ["#"] to get tag completion working
  static _rxFileExtensions = '\\.(md|markdown|mdx|fountain)$';
  static _defaultFileExtension = 'md';
  static SLUGIFY_NONE = 'NONE';
  static _defaultSlugifyChar = '-';
  static _slugifyChar = '-';
  static DEFAULT_CONFIG = {
    createNoteOnGoToDefinitionWhenMissing: true,
    defaultFileExtension: NoteWorkspace._defaultFileExtension,
    noteCompletionConvention: NoteCompletionConvention.rawFilename,
    slugifyCharacter: SlugifyCharacter.dash,
    workspaceFilenameConvention: WorkspaceFilenameConvention.uniqueFilenames,
  };
  static DOCUMENT_SELECTOR = [
    // { scheme: 'file', language: 'markdown' },
    // { scheme: 'file', language: 'mdx' },
    { language: 'markdown' },
    { language: 'mdx' },
  ];

  static cfg(): Config {
    let c = vscode.workspace.getConfiguration('vscodeMarkdownNotes');
    return {
      createNoteOnGoToDefinitionWhenMissing: c.get(
        'createNoteOnGoToDefinitionWhenMissing'
      ) as boolean,
      defaultFileExtension: c.get('defaultFileExtension') as string,
      noteCompletionConvention: c.get('noteCompletionConvention') as NoteCompletionConvention,
      slugifyCharacter: c.get('slugifyCharacter') as SlugifyCharacter,
      workspaceFilenameConvention: c.get(
        'workspaceFilenameConvention'
      ) as WorkspaceFilenameConvention,
    };
  }

  static slugifyChar(): string {
    return this.cfg().slugifyCharacter;
  }

  static defaultFileExtension(): string {
    return this.cfg().defaultFileExtension;
  }

  static rxTagNoAnchors(): RegExp {
    // NB: MUST have g flag to match multiple words per line
    // return /\#[\w\-\_]+/i; // used to match tags that appear within lines
    return new RegExp(this._rxTagNoAnchors, 'gi');
  }
  static rxTagWithAnchors(): RegExp {
    // NB: MUST have g flag to match multiple words per line
    // return /^\#[\w\-\_]+$/i; // used to match entire words
    return new RegExp(this._rxTagWithAnchors, 'gi');
  }
  static rxWikiLink(): RegExp {
    // NB: MUST have g flag to match multiple words per line
    // return /\[\[[\w\.\-\_\/\\]+/i; // [[wiki-link-regex
    return new RegExp(this._rxWikiLink, 'gi');
  }
  static rxMarkdownWordPattern(): RegExp {
    // return /([\#\.\/\\\w_]+)/; // had to add [".", "/", "\"] to get relative path completion working and ["#"] to get tag completion working
    return new RegExp(this._rxMarkdownWordPattern);
  }
  static rxFileExtensions(): RegExp {
    // return noteName.replace(/\.(md|markdown|mdx|fountain)$/i, '');
    return new RegExp(this._rxFileExtensions, 'i');
  }

  static wikiLinkCompletionForConvention(
    uri: vscode.Uri,
    fromDocument: vscode.TextDocument
  ): string {
    if (this.useUniqueFilenames()) {
      let filename = basename(uri.fsPath);
      let c = this.cfg().noteCompletionConvention;
      return this._wikiLinkCompletionForConvention(c, filename);
    } else {
      let toPath = uri.fsPath;
      let fromDir = dirname(fromDocument.uri.fsPath.toString());
      let rel = normalize(relative(fromDir, toPath));
      return rel;
    }
  }

  static _wikiLinkCompletionForConvention(convention: string, filename: string): string {
    if (convention == 'toSpaces') {
      return this.stripExtension(filename).replace(/[-_]+/g, ' ');
    } else if (convention == 'noExtension') {
      return this.stripExtension(filename);
    } else {
      return filename;
    }
  }

  static useUniqueFilenames(): boolean {
    // return false;
    return this.cfg().workspaceFilenameConvention == 'uniqueFilenames';
  }

  static createNoteOnGoToDefinitionWhenMissing(): boolean {
    return !!this.cfg().createNoteOnGoToDefinitionWhenMissing;
  }

  static stripExtension(noteName: string): string {
    return noteName.replace(NoteWorkspace.rxFileExtensions(), '');
  }

  static normalizeNoteNameForFuzzyMatch(noteName: string): string {
    // remove the brackets:
    let n = noteName.replace(/[\[\]]/g, '');
    // remove the filepath:
    // NB: this may not work with relative paths?
    n = basename(n);
    // remove the extension:
    n = this.stripExtension(n);
    // // remove '/' characters
    // n = n.replace(/\//g, '');
    // slugify (to normalize spaces)
    n = this.slugifyTitle(n);
    return n;
  }

  // Compare 2 wiki-links for a fuzzy match.
  // All of the following will return true
  static noteNamesFuzzyMatch(left: string, right: string): boolean {
    console.debug(
      `left: '${this.normalizeNoteNameForFuzzyMatch(
        left
      )}' right: '${this.normalizeNoteNameForFuzzyMatch(right)}'`
    );
    return this.normalizeNoteNameForFuzzyMatch(left) == this.normalizeNoteNameForFuzzyMatch(right);
  }

  static slugifyTitle(title: string): string {
    return title
      .replace(/\W+/gi, this.slugifyChar()) // non-words to hyphens (or underscores)
      .toLowerCase() // lower
      .replace(/[-_]*$/, ''); // removing trailing '-' and '_' chars
  }

  static noteFileNameFromTitle(title: string): string {
    let t = this.slugifyChar() == this.SLUGIFY_NONE ? title : this.slugifyTitle(title);
    return t.match(this.rxFileExtensions()) ? t : `${t}.${this.defaultFileExtension()}`;
  }

  static newNote(context: vscode.ExtensionContext) {
    // console.debug('newNote');
    const inputBoxPromise = vscode.window.showInputBox({
      prompt:
        "Enter a 'Title Case Name' to create `title-case-name.md` with '# Title Case Name' at the top.",
      value: '',
    });

    let workspaceUri = '';
    if (vscode.workspace.workspaceFolders) {
      workspaceUri = vscode.workspace.workspaceFolders[0].uri.fsPath.toString();
    }

    inputBoxPromise.then(
      (noteName) => {
        if (noteName == null || !noteName || noteName.replace(/\s+/g, '') == '') {
          // console.debug('Abort: noteName was empty.');
          return false;
        }

        const filename = NoteWorkspace.noteFileNameFromTitle(noteName);
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

  static overrideMarkdownWordPattern() {
    // console.debug('overrideMarkdownWordPattern');
    this.DOCUMENT_SELECTOR.map((ds) => {
      vscode.languages.setLanguageConfiguration(ds.language, {
        wordPattern: this.rxMarkdownWordPattern(),
      });
    });
  }

  static async noteFiles(): Promise<Array<vscode.Uri>> {
    let that = this;
    let files = (await vscode.workspace.findFiles('**/*')).filter(
      (f) => f.scheme == 'file' && f.path.match(that.rxFileExtensions())
    );
    return files;
  }
}
