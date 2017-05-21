import fs from 'fs';
import path from 'path';

import {File} from 'atom';
import {CompositeDisposable, Disposable} from 'event-kit';

import React from 'react';
import PropTypes from 'prop-types';
import {autobind} from 'core-decorators';

import EtchWrapper from '../views/etch-wrapper';
import StatusBar from '../views/status-bar';
import Panel from '../views/panel';
import PaneItem from '../views/pane-item';
import DockItem from '../views/dock-item';
import Resizer from '../views/resizer';
import Tabs from '../views/tabs';
import CloneDialog from '../views/clone-dialog';
import OpenIssueishDialog from '../views/open-issueish-dialog';
import InitDialog from '../views/init-dialog';
import CredentialDialog from '../views/credential-dialog';
import Commands, {Command} from '../views/commands';
import GithubTabController from './github-tab-controller';
import FilePatchController from './file-patch-controller';
import GitTabController from './git-tab-controller';
import StatusBarTileController from './status-bar-tile-controller';
import RepositoryConflictController from './repository-conflict-controller';
import ModelObserver from '../models/model-observer';
import ModelStateRegistry from '../models/model-state-registry';
import Conflict from '../models/conflicts/conflict';
import Switchboard from '../switchboard';
import {copyFile, deleteFileOrFolder} from '../helpers';
import {GitError} from '../git-shell-out-strategy';

const nullFilePatchState = {
  filePath: null,
  filePatch: null,
  stagingStatus: 'unstaged',
  partiallyStaged: false,
};

export default class RootController extends React.Component {
  static propTypes = {
    workspace: PropTypes.object.isRequired,
    commandRegistry: PropTypes.object.isRequired,
    notificationManager: PropTypes.object.isRequired,
    tooltips: PropTypes.object.isRequired,
    config: PropTypes.object.isRequired,
    confirm: PropTypes.func.isRequired,
    activeWorkingDirectory: PropTypes.string,
    createRepositoryForProjectPath: PropTypes.func,
    cloneRepositoryForProjectPath: PropTypes.func,
    repository: PropTypes.object.isRequired,
    resolutionProgress: PropTypes.object.isRequired,
    statusBar: PropTypes.object,
    switchboard: PropTypes.instanceOf(Switchboard),
    savedState: PropTypes.object,
    useLegacyPanels: PropTypes.bool,
    firstRun: React.PropTypes.bool,
  }

  static defaultProps = {
    switchboard: new Switchboard(),
    savedState: {},
    useLegacyPanels: false,
    firstRun: true,
  }

  serialize() {
    return {
      gitTabActive: this.state.gitTabActive,
      githubTabActive: this.state.githubTabActive,
      panelSize: this.state.panelSize,
      activeTab: this.state.activeTab,
    };
  }

  constructor(props, context) {
    super(props, context);
    this.state = {
      ...nullFilePatchState,
      amending: false,
      gitTabActive: props.firstRun || props.savedState.gitTabActive,
      githubTabActive: props.firstRun || props.savedState.githubTabActive || props.savedState.githubPanelActive,
      panelSize: props.savedState.panelSize || 400,
      activeTab: props.savedState.activeTab || 0,
      cloneDialogActive: false,
      cloneDialogInProgress: false,
      initDialogActive: false,
      credentialDialogQuery: null,
    };

    this.repositoryStateRegistry = new ModelStateRegistry(RootController, {
      save: () => {
        return {amending: this.state.amending};
      },
      restore: (state = {}) => {
        this.setState({amending: !!state.amending});
      },
    });

    this.subscriptions = new CompositeDisposable();

    this.repositoryObserver = new ModelObserver({
      didUpdate: () => this.onRepoRefresh(),
    });
    this.repositoryObserver.setActiveModel(props.repository);
    this.subscriptions.add(
      new Disposable(() => this.repositoryObserver.destroy()),
    );

    this.gitTabTracker = new TabTracker('git', {
      getState: () => this.state.gitTabActive,
      setState: (value, callback) => this.setState({gitTabActive: value}, callback),
      getController: () => this.gitTabController,
      getDockItem: () => this.gitDockItem,
      getWorkspace: () => this.props.workspace,
    });

    this.githubTabTracker = new TabTracker('github', {
      getState: () => this.state.githubTabActive,
      setState: (value, callback) => this.setState({githubTabActive: value}, callback),
      getController: () => this.githubTabController,
      getDockItem: () => this.githubDockItem,
      getWorkspace: () => this.props.workspace,
    });
  }

  componentWillMount() {
    this.repositoryStateRegistry.setModel(this.props.repository);
  }

  componentWillReceiveProps(newProps) {
    this.repositoryObserver.setActiveModel(newProps.repository);
    this.repositoryStateRegistry.setModel(newProps.repository);
  }

  render() {
    return (
      <div>
        <Commands registry={this.props.commandRegistry} target="atom-workspace">
          <Command command="github:show-waterfall-diagnostics" callback={this.showWaterfallDiagnostics} />
          <Command command="github:open-issue-or-pull-request" callback={this.showOpenIssueishDialog} />
          <Command command="github:toggle-git-tab" callback={this.gitTabTracker.toggle} />
          <Command command="github:toggle-git-tab-focus" callback={this.gitTabTracker.toggleFocus} />
          <Command command="github:toggle-github-tab" callback={this.githubTabTracker.toggle} />
          <Command command="github:toggle-github-tab-focus" callback={this.githubTabTracker.toggleFocus} />
          <Command command="github:clone" callback={this.openCloneDialog} />
        </Commands>
        {this.renderStatusBarTile()}
        {this.renderPanels()}
        {(this.state.filePath && this.state.filePatch) ? this.renderFilePatchController() : null}
        {this.renderInitDialog()}
        {this.renderCloneDialog()}
        {this.renderCredentialDialog()}
        {this.renderOpenIssueishDialog()}
        {this.renderRepositoryConflictController()}
      </div>
    );
  }

  renderStatusBarTile() {
    return (
      <StatusBar statusBar={this.props.statusBar} onConsumeStatusBar={sb => this.onConsumeStatusBar(sb)}>
        <StatusBarTileController
          workspace={this.props.workspace}
          repository={this.props.repository}
          commandRegistry={this.props.commandRegistry}
          notificationManager={this.props.notificationManager}
          tooltips={this.props.tooltips}
          confirm={this.props.confirm}
          toggleGitTab={this.gitTabTracker.toggle}
        />
      </StatusBar>
    );
  }

  renderPanels() {
    if (!this.props.useLegacyPanels) {
      const gitTab = this.state.gitTabActive && (
        <DockItem
          ref={c => { this.gitDockItem = c; }}
          workspace={this.props.workspace}
          getItem={({subtree}) => subtree.getWrappedComponent()}
          onDidCloseItem={() => this.setState({gitTabActive: false})}
          stubItemSelector="git-tab-controller"
          activate={this.props.firstRun}>
          <EtchWrapper
            ref={c => { this.gitTabController = c; }}
            className="github-PanelEtchWrapper"
            reattachDomNode={false}>
            <GitTabController
              workspace={this.props.workspace}
              commandRegistry={this.props.commandRegistry}
              notificationManager={this.props.notificationManager}
              repository={this.props.repository}
              initializeRepo={this.initializeRepo}
              resolutionProgress={this.props.resolutionProgress}
              isAmending={this.state.amending}
              didSelectFilePath={this.showFilePatchForPath}
              didDiveIntoFilePath={this.diveIntoFilePatchForPath}
              didSelectMergeConflictFile={this.showMergeConflictFileForPath}
              didDiveIntoMergeConflictPath={this.diveIntoMergeConflictFileForPath}
              didChangeAmending={this.didChangeAmending}
              focusFilePatchView={this.focusFilePatchView}
              ensureGitTab={this.gitTabTracker.ensureVisible}
              openFiles={this.openFiles}
              discardWorkDirChangesForPaths={this.discardWorkDirChangesForPaths}
              undoLastDiscard={this.undoLastDiscard}
              refreshResolutionProgress={this.refreshResolutionProgress}
            />
          </EtchWrapper>
        </DockItem>
      );

      const githubTab = this.state.githubTabActive && (
        <DockItem
          ref={c => { this.githubDockItem = c; }}
          workspace={this.props.workspace}
          onDidCloseItem={() => this.setState({githubTabActive: false})}
          stubItemSelector="github-tab-controller">
          <GithubTabController
            ref={c => { this.githubTabController = c; }}
            repository={this.props.repository}
            commandRegistry={this.props.commandRegistry}
          />
        </DockItem>
      );

      return <div>{gitTab}{githubTab}</div>;
    }

    return (
      <Panel
        workspace={this.props.workspace}
        location="right"
        onDidClosePanel={() => this.setState({gitTabActive: false})}
        visible={!!this.state.gitTabActive}>
        <Resizer
          size={this.state.panelSize}
          onChange={this.handlePanelResize}
          className="github-PanelResizer">
          <Tabs activeIndex={this.state.activeTab} onChange={this.handleChangeTab} className="sidebar-tabs">
            <Tabs.Panel title="Git">
              <EtchWrapper
                ref={c => { this.gitTabController = c; }}
                className="github-PanelEtchWrapper"
                reattachDomNode={false}>
                <GitTabController
                  workspace={this.props.workspace}
                  commandRegistry={this.props.commandRegistry}
                  notificationManager={this.props.notificationManager}
                  repository={this.props.repository}
                  initializeRepo={this.initializeRepo}
                  resolutionProgress={this.props.resolutionProgress}
                  isAmending={this.state.amending}
                  didSelectFilePath={this.showFilePatchForPath}
                  didDiveIntoFilePath={this.diveIntoFilePatchForPath}
                  didSelectMergeConflictFile={this.showMergeConflictFileForPath}
                  didDiveIntoMergeConflictPath={this.diveIntoMergeConflictFileForPath}
                  didChangeAmending={this.didChangeAmending}
                  focusFilePatchView={this.focusFilePatchView}
                  ensureGitTab={this.gitTabTracker.ensureVisible}
                  openFiles={this.openFiles}
                  discardWorkDirChangesForPaths={this.discardWorkDirChangesForPaths}
                  undoLastDiscard={this.undoLastDiscard}
                  refreshResolutionProgress={this.refreshResolutionProgress}
                />
              </EtchWrapper>
            </Tabs.Panel>
            <Tabs.Panel title="GitLab (preview)">
              <GithubTabController
                ref={c => { this.githubTabController = c; }}
                repository={this.props.repository}
                commandRegistry={this.props.commandRegistry}
              />
            </Tabs.Panel>
          </Tabs>
        </Resizer>
      </Panel>
    );
  }

  renderFilePatchController() {
    return (
      <div>
        <Commands registry={this.props.commandRegistry} target="atom-workspace">
          <Command command="github:focus-diff-view" callback={this.focusFilePatchView} />
        </Commands>
        <PaneItem
          workspace={this.props.workspace}
          ref={c => { this.filePatchControllerPane = c; }}
          onDidCloseItem={() => { this.setState({...nullFilePatchState}); }}>
          <FilePatchController
            activeWorkingDirectory={this.props.activeWorkingDirectory}
            repository={this.props.repository}
            commandRegistry={this.props.commandRegistry}
            filePatch={this.state.filePatch}
            stagingStatus={this.state.stagingStatus}
            isAmending={this.state.amending}
            isPartiallyStaged={this.state.partiallyStaged}
            onRepoRefresh={this.onRepoRefresh}
            didSurfaceFile={this.surfaceFromFileAtPath}
            didDiveIntoFilePath={this.diveIntoFilePatchForPath}
            quietlySelectItem={this.quietlySelectItem}
            openFiles={this.openFiles}
            discardLines={this.discardLines}
            undoLastDiscard={this.undoLastDiscard}
            switchboard={this.props.switchboard}
          />
        </PaneItem>
      </div>
    );
  }

  renderInitDialog() {
    if (!this.state.initDialogActive) {
      return null;
    }

    return (
      <Panel workspace={this.props.workspace} location="modal">
        <InitDialog
          config={this.props.config}
          commandRegistry={this.props.commandRegistry}
          didAccept={this.acceptInit}
          didCancel={this.cancelInit}
        />
      </Panel>
    );
  }

  renderCloneDialog() {
    if (!this.state.cloneDialogActive) {
      return null;
    }

    return (
      <Panel workspace={this.props.workspace} location="modal">
        <CloneDialog
          config={this.props.config}
          commandRegistry={this.props.commandRegistry}
          didAccept={this.acceptClone}
          didCancel={this.cancelClone}
          inProgress={this.state.cloneDialogInProgress}
        />
      </Panel>
    );
  }

  renderOpenIssueishDialog() {
    if (!this.state.openIssueishDialogActive) {
      return null;
    }

    return (
      <Panel workspace={this.props.workspace} location="modal">
        <OpenIssueishDialog
          commandRegistry={this.props.commandRegistry}
          didAccept={this.acceptOpenIssueish}
          didCancel={this.cancelOpenIssueish}
        />
      </Panel>
    );
  }

  renderCredentialDialog() {
    if (this.state.credentialDialogQuery === null) {
      return null;
    }

    return (
      <Panel workspace={this.props.workspace} location="modal">
        <CredentialDialog commandRegistry={this.props.commandRegistry} {...this.state.credentialDialogQuery} />
      </Panel>
    );
  }

  renderRepositoryConflictController() {
    if (!this.props.repository) {
      return null;
    }

    return (
      <RepositoryConflictController
        workspace={this.props.workspace}
        repository={this.props.repository}
        resolutionProgress={this.props.resolutionProgress}
        refreshResolutionProgress={this.refreshResolutionProgress}
        commandRegistry={this.props.commandRegistry}
      />
    );
  }

  componentWillUnmount() {
    this.repositoryStateRegistry.save();
    this.subscriptions.dispose();
  }

  onConsumeStatusBar(statusBar) {
    if (statusBar.disableGitInfoTile) {
      statusBar.disableGitInfoTile();
    }
  }

  @autobind
  async initializeRepo() {
    if (this.props.activeWorkingDirectory) {
      await this.acceptInit(this.props.activeWorkingDirectory);
      return;
    }

    this.setState({initDialogActive: true});
  }

  @autobind
  showOpenIssueishDialog() {
    this.setState({openIssueishDialogActive: true});
  }

  @autobind
  showWaterfallDiagnostics() {
    this.props.workspace.open('atom-github://debug/timings');
  }

  @autobind
  async acceptClone(remoteUrl, projectPath) {
    this.setState({cloneDialogInProgress: true});
    try {
      await this.props.cloneRepositoryForProjectPath(remoteUrl, projectPath);
    } catch (e) {
      this.props.notificationManager.addError(
        `Unable to clone ${remoteUrl}`,
        {detail: e.stdErr, dismissable: true},
      );
    } finally {
      this.setState({cloneDialogInProgress: false, cloneDialogActive: false});
    }
  }

  @autobind
  cancelClone() {
    this.setState({cloneDialogActive: false});
  }

  @autobind
  async acceptInit(projectPath) {
    try {
      await this.props.createRepositoryForProjectPath(projectPath);
    } catch (e) {
      this.props.notificationManager.addError(
        `Unable to initialize git repository in ${projectPath}`,
        {detail: e.stdErr, dismissable: true},
      );
    } finally {
      this.setState({initDialogActive: false});
    }
  }

  @autobind
  cancelInit() {
    this.setState({initDialogActive: false});
  }

  @autobind
  acceptOpenIssueish({repoOwner, repoName, issueishNumber}) {
    const uri = `atom-github://issueish/https://api.github.com/${repoOwner}/${repoName}/${issueishNumber}`;
    this.setState({openIssueishDialogActive: false});
    this.props.workspace.open(uri);
  }

  @autobind
  cancelOpenIssueish() {
    this.setState({openIssueishDialogActive: false});
  }

  @autobind
  async showFilePatchForPath(filePath, stagingStatus, {activate, amending} = {}) {
    if (!filePath) { return null; }
    const repository = this.props.repository;
    if (!repository) { return null; }

    const staged = stagingStatus === 'staged';
    const filePatch = await repository.getFilePatchForPath(filePath, {staged, amending: staged && amending});
    const partiallyStaged = await repository.isPartiallyStaged(filePath);
    return new Promise(resolve => {
      if (filePatch) {
        this.setState({filePath, filePatch, stagingStatus, partiallyStaged}, () => {
          // TODO: can be better done w/ a prop?
          if (activate && this.filePatchControllerPane) {
            this.filePatchControllerPane.activate();
          }
          this.props.switchboard.didFinishRender('RootController.showFilePatchForPath');
          resolve();
        });
      } else {
        this.setState({...nullFilePatchState}, () => {
          this.props.switchboard.didFinishRender('RootController.showFilePatchForPath');
          resolve();
        });
      }
    });
  }

  @autobind
  async diveIntoFilePatchForPath(filePath, stagingStatus, {amending} = {}) {
    await this.showFilePatchForPath(filePath, stagingStatus, {activate: true, amending});
    this.focusFilePatchView();
  }

  @autobind
  surfaceFromFileAtPath(filePath, stagingStatus) {
    if (this.gitTabController) {
      this.gitTabController.getWrappedComponent().focusAndSelectStagingItem(filePath, stagingStatus);
    }
  }

  @autobind
  onRepoRefresh() {
    return this.showFilePatchForPath(this.state.filePath, this.state.stagingStatus, {amending: this.state.amending});
  }

  @autobind
  async showMergeConflictFileForPath(relativeFilePath, {focus} = {}) {
    const absolutePath = path.join(this.props.repository.getWorkingDirectoryPath(), relativeFilePath);
    if (await new File(absolutePath).exists()) {
      return this.props.workspace.open(absolutePath, {activatePane: Boolean(focus), pending: true});
    } else {
      this.props.notificationManager.addInfo('File has been deleted.');
      return null;
    }
  }

  @autobind
  diveIntoMergeConflictFileForPath(relativeFilePath) {
    return this.showMergeConflictFileForPath(relativeFilePath, {focus: true});
  }

  @autobind
  didChangeAmending(isAmending) {
    this.setState({amending: isAmending});
    return this.showFilePatchForPath(this.state.filePath, this.state.stagingStatus, {amending: isAmending});
  }

  @autobind
  openCloneDialog() {
    this.setState({cloneDialogActive: true});
  }

  @autobind
  handlePanelResize(size) {
    this.setState({
      panelSize: Math.max(size, 300),
    });
  }

  @autobind
  handleChangeTab(activeTab) {
    this.setState({activeTab});
  }

  @autobind
  quietlySelectItem(filePath, stagingStatus) {
    if (this.gitTabController) {
      return this.gitTabController.getWrappedComponent().quietlySelectItem(filePath, stagingStatus);
    } else {
      return null;
    }
  }

  @autobind
  focusFilePatchView() {
    const item = this.filePatchControllerPane.getPaneItem();
    const viewElement = item.getElement().querySelector('[tabindex]');
    viewElement.focus();
  }

  @autobind
  openFiles(filePaths) {
    return Promise.all(filePaths.map(filePath => {
      const absolutePath = path.join(this.props.repository.getWorkingDirectoryPath(), filePath);
      return this.props.workspace.open(absolutePath, {pending: filePaths.length === 1});
    }));
  }

  @autobind
  getUnsavedFiles(filePaths) {
    const isModifiedByPath = new Map();
    this.props.workspace.getTextEditors().forEach(editor => {
      isModifiedByPath.set(editor.getPath(), editor.isModified());
    });
    return filePaths.filter(filePath => {
      const absFilePath = path.join(this.props.repository.getWorkingDirectoryPath(), filePath);
      return isModifiedByPath.get(absFilePath);
    });
  }

  @autobind
  ensureNoUnsavedFiles(filePaths, message) {
    const unsavedFiles = this.getUnsavedFiles(filePaths).map(filePath => `\`${filePath}\``).join('<br>');
    if (unsavedFiles.length) {
      this.props.notificationManager.addError(
        message,
        {
          description: `You have unsaved changes in:<br>${unsavedFiles}.`,
          dismissable: true,
        },
      );
      return false;
    } else {
      return true;
    }
  }

  @autobind
  async discardWorkDirChangesForPaths(filePaths) {
    const destructiveAction = () => {
      return this.props.repository.discardWorkDirChangesForPaths(filePaths);
    };
    return await this.props.repository.storeBeforeAndAfterBlobs(
      filePaths,
      () => this.ensureNoUnsavedFiles(filePaths, 'Cannot discard changes in selected files.'),
      destructiveAction,
    );
  }

  @autobind
  async discardLines(lines) {
    const filePath = this.state.filePatch.getPath();
    const filePatch = this.state.filePatch;
    const destructiveAction = async () => {
      const discardFilePatch = filePatch.getUnstagePatchForLines(lines);
      await this.props.repository.applyPatchToWorkdir(discardFilePatch);
    };
    return await this.props.repository.storeBeforeAndAfterBlobs(
      [filePath],
      () => this.ensureNoUnsavedFiles([filePath], 'Cannot discard lines.'),
      destructiveAction,
      filePath,
    );
  }

  getFilePathsForLastDiscard(partialDiscardFilePath = null) {
    let lastSnapshots = this.props.repository.getLastHistorySnapshots(partialDiscardFilePath);
    if (partialDiscardFilePath) {
      lastSnapshots = lastSnapshots ? [lastSnapshots] : [];
    }
    return lastSnapshots.map(snapshot => snapshot.filePath);
  }

  @autobind
  async undoLastDiscard(partialDiscardFilePath = null) {
    const filePaths = this.getFilePathsForLastDiscard(partialDiscardFilePath);
    try {
      const results = await this.props.repository.restoreLastDiscardInTempFiles(
        () => this.ensureNoUnsavedFiles(filePaths, 'Cannot undo last discard.'),
        partialDiscardFilePath,
      );
      if (results.length === 0) { return; }
      await this.proceedOrPromptBasedOnResults(results, partialDiscardFilePath);
    } catch (e) {
      if (e instanceof GitError && e.stdErr.match(/fatal: Not a valid object name/)) {
        this.cleanUpHistoryForFilePaths(filePaths, partialDiscardFilePath);
      } else {
        // eslint-disable-next-line no-console
        console.error(e);
      }
    }
  }

  async proceedOrPromptBasedOnResults(results, partialDiscardFilePath = null) {
    const conflicts = results.filter(({conflict}) => conflict);
    if (conflicts.length === 0) {
      await this.proceedWithLastDiscardUndo(results, partialDiscardFilePath);
    } else {
      await this.promptAboutConflicts(results, conflicts, partialDiscardFilePath);
    }
  }

  async promptAboutConflicts(results, conflicts, partialDiscardFilePath = null) {
    const conflictedFiles = conflicts.map(({filePath}) => `\t${filePath}`).join('\n');
    const choice = this.props.confirm({
      message: 'Undoing will result in conflicts...',
      detailedMessage: `for the following files:\n${conflictedFiles}\n` +
        'Would you like to apply the changes with merge conflict markers, ' +
        'or open the text with merge conflict markers in a new file?',
      buttons: ['Merge with conflict markers', 'Open in new file', 'Cancel undo'],
    });
    if (choice === 0) {
      await this.proceedWithLastDiscardUndo(results, partialDiscardFilePath);
    } else if (choice === 1) {
      await this.openConflictsInNewEditors(conflicts.map(({resultPath}) => resultPath));
    }
  }

  cleanUpHistoryForFilePaths(filePaths, partialDiscardFilePath = null) {
    this.props.repository.clearDiscardHistory(partialDiscardFilePath);
    const filePathsStr = filePaths.map(filePath => `\`${filePath}\``).join('<br>');
    this.props.notificationManager.addError(
      'Discard history has expired.',
      {
        description: `Cannot undo discard for<br>${filePathsStr}<br>Stale discard history has been deleted.`,
        dismissable: true,
      },
    );
  }

  async proceedWithLastDiscardUndo(results, partialDiscardFilePath = null) {
    const promises = results.map(async result => {
      const {filePath, resultPath, deleted, conflict, theirsSha, commonBaseSha, currentSha} = result;
      const absFilePath = path.join(this.props.repository.getWorkingDirectoryPath(), filePath);
      if (deleted && resultPath === null) {
        await deleteFileOrFolder(absFilePath);
      } else {
        await copyFile(resultPath, absFilePath);
      }
      if (conflict) {
        await this.props.repository.writeMergeConflictToIndex(filePath, commonBaseSha, currentSha, theirsSha);
      }
    });
    await Promise.all(promises);
    await this.props.repository.popDiscardHistory(partialDiscardFilePath);
  }

  async openConflictsInNewEditors(resultPaths) {
    const editorPromises = resultPaths.map(resultPath => {
      return this.props.workspace.open(resultPath);
    });
    return await Promise.all(editorPromises);
  }

  /*
   * Asynchronously count the conflict markers present in a file specified by full path.
   */
  @autobind
  refreshResolutionProgress(fullPath) {
    const readStream = fs.createReadStream(fullPath, {encoding: 'utf8'});
    return new Promise(resolve => {
      Conflict.countFromStream(readStream).then(count => {
        this.props.resolutionProgress.reportMarkerCount(fullPath, count);
      });
    });
  }

  /*
   * Display the credential entry dialog. Return a Promise that will resolve with the provided credentials on accept
   * or reject on cancel.
   */
  promptForCredentials(query) {
    return new Promise((resolve, reject) => {
      this.setState({
        credentialDialogQuery: {
          ...query,
          onSubmit: response => this.setState({credentialDialogQuery: null}, () => resolve(response)),
          onCancel: () => this.setState({credentialDialogQuery: null}, reject),
        },
      });
    });
  }
}

class TabTracker {
  constructor(name, {getState, setState, getController, getDockItem, getWorkspace}) {
    this.name = name;

    this.getState = getState;
    this.getWorkspace = getWorkspace;
    this.getController = getController;

    this.setStateKey = value => {
      return new Promise(resolve => setState(value, resolve));
    };
    this.getDockItem = () => {
      const item = getDockItem();
      return item ? item.getDockItem() : null;
    };
  }

  getControllerComponent() {
    const controller = this.getController();

    if (!controller.getWrappedComponent) {
      return controller;
    }

    return controller.getWrappedComponent();
  }

  @autobind
  async toggle() {
    const focusToRestore = document.activeElement;
    let shouldRestoreFocus = false;

    if (!this.getState()) {
      await this.setStateKey(true);
      shouldRestoreFocus = true;
    } else if (this.getDockItem()) {
      shouldRestoreFocus = await this.getWorkspace().toggle(this.getDockItem()) !== undefined;
    } else {
      // Legacy panels.
      await this.setStateKey(false);
    }

    if (shouldRestoreFocus) {
      process.nextTick(() => focusToRestore.focus());
    }
  }

  @autobind
  async toggleFocus() {
    await this.ensureVisible();

    if (this.hasFocus()) {
      let workspace = this.getWorkspace();
      if (workspace.getCenter) {
        workspace = workspace.getCenter();
      }
      workspace.getActivePane().activate();
    } else {
      this.focus();
    }
  }

  @autobind
  async ensureVisible() {
    if (!this.isVisible()) {
      await this.setStateKey(true);
      if (this.getDockItem()) {
        await this.getWorkspace().open(this.getDockItem());
      }
      return true;
    }
    return false;
  }

  focus() {
    this.getControllerComponent().restoreFocus();
  }

  isVisible() {
    if (!this.getState()) {
      return false;
    }

    const item = this.getDockItem();
    if (!item) {
      // Legacy panels active. Use getState(), which is true.
      return true;
    }

    const workspace = this.getWorkspace();
    return workspace.getPaneContainers()
      .filter(container => container === workspace.getCenter() || container.isVisible())
      .some(container => container.getPanes().some(pane => pane.getActiveItem() === item));
  }

  hasFocus() {
    return this.getControllerComponent().hasFocus();
  }
}
