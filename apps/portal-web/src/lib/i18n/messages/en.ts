// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 1: English reference catalog.
 *
 * Single TypeScript object so the build-time type check enforces
 * the shape across every non-English catalog. Phase 1.0 seeds a
 * small initial slice — the most prominent surfaces a brand-new
 * visitor sees first — so the i18n plumbing is demonstrably
 * working without trying to translate every component in one
 * commit. Phase 1.1 ships the multi-week mechanical sweep across
 * the rest of the UI; until then, components that aren't yet
 * wired up just stay in English regardless of the selected
 * locale.
 *
 * Convention: namespace.subsection.key. Each value is plain text
 * or an ICU MessageFormat string. Interpolations use the
 * `{name}` syntax; pluralization uses `{count, plural, one {...}
 * other {...}}`. The runtime helper applies the same shape no
 * matter the locale, so a community translation only needs to
 * replace the values.
 */
export const en = {
  common: {
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    close: 'Close',
    edit: 'Edit',
    loading: 'Loading…',
    backToItems: 'Back to items',
    settings: 'Settings',
    language: 'Language',
  },
  nav: {
    items: 'Items',
    home: 'Home',
    admin: 'Admin',
    profile: 'Profile',
    signOut: 'Sign out',
    signIn: 'Sign in',
    overview: 'Overview',
    folders: 'Folders',
    groups: 'Groups',
    recentlyDeleted: 'Recently deleted',
    users: 'Users',
    landingPage: 'Landing page',
    backup: 'Backup',
    housekeeping: 'Housekeeping',
    notifications: 'Notifications',
    fieldQueues: 'Field queues',
    migrations: 'Migrations',
    gettingStarted: 'Getting started',
  },
  shell: {
    notificationsLabel: 'Notifications',
    navigation: 'Navigation',
    openNavigation: 'Open navigation',
    closeNavigation: 'Close navigation',
  },
  search: {
    placeholder: 'Search items...',
    label: 'Search items',
  },
  help: {
    buttonTitle: 'Help (press ? anywhere)',
    openLabel: 'Open help',
  },
  newItem: {
    pageTitle: 'Create a new item',
    pageIntro:
      "Pick what you're creating, then fill in the details. For services and uploads, we'll gather what we need on the next screen so the item lands ready to use.",
    createButton: 'Create item',
    backButton: 'Back',
  },
  mapEditor: {
    legendButton: 'Legend',
    tableButton: 'Attribute table',
    markupButton: 'Markup',
    commentsButton: 'Comments',
    printButton: 'Print this map',
    layerAccessButton: 'Layer access',
    saveMapButton: 'Save map',
    savedIndicator: 'Saved',
  },
  featureEdit: {
    groupLabel: 'Edit',
    editShape: 'Edit shape',
    addFeature: 'Add feature',
    deleteFeature: 'Delete feature',
    layerToAddTo: 'Layer to add to',
    snappingOn: 'Snapping on',
    snappingOff: 'Snapping off',
    hintEdit: 'Click a feature on an editable layer to move its vertices.',
    hintLoading: 'Loading the feature...',
    hintDelete: 'Click a feature on an editable layer to delete it.',
    hintAddPoint: 'Click the map to place the feature.',
    hintAddPath:
      'Click to add vertices; double-click or click the first vertex to finish.',
    editingIn: 'Editing a feature in {layer}. Drag vertices; click a midpoint to add one.',
    cancel: 'Cancel',
    saveShape: 'Save shape',
    shapeSaved: 'Shape saved.',
    featureAdded: 'Feature added.',
    featureDeleted: 'Feature deleted.',
    newFeatureTitle: 'New feature',
    newFeatureAttributes: 'New feature attributes',
    addAction: 'Add feature',
    deleteConfirmTitle: 'Delete this feature?',
    deleteConfirmMessage:
      'It will be removed from "{layer}". This cannot be undone from here.',
    deleteAction: 'Delete',
    noStableId: 'This feature has no stable id and cannot be edited here.',
    noGeometry: 'This layer has no geometry to edit.',
    notFound: 'Could not find that feature on the server.',
    loadFailed: 'Could not load the feature.',
    saveFailed: 'Save failed.',
    deleteFailed: 'Delete failed.',
    addFailed: 'Could not add the feature.',
  },
  presence: {
    youSuffix: ' (you)',
  },
  comments: {
    title: 'Comments',
    showResolved: 'Show resolved',
    startThread: 'Start a new thread...',
    post: 'Post',
    reply: 'Reply...',
    resolve: 'Resolve',
    reopen: 'Reopen',
    threadCount:
      '{count, plural, one {# thread} other {# threads}}',
    noOpen:
      'No open threads. Toggle "Show resolved" to see closed ones.',
    noComments: 'No comments yet. Start the conversation below.',
    signInPrompt: 'Sign in to comment on this map.',
  },
  markup: {
    title: 'Markup',
    add: 'Add markup',
    empty:
      'No markup yet. Add a set, then drop pins to mark up the map.',
    dropPin: 'Drop pin at center',
    signInPrompt: 'Sign in to add markup to this map.',
  },
  print: {
    chooserTitle: 'Print this map',
    startSection: 'Start a new layout',
    startAction:
      'Create a new print layout pre-bound to this map',
    startHint:
      'Opens the print layout designer with this map already wired up to the Map, Legend, Scalebar, and North arrow elements.',
    pickSection: 'Use an existing layout',
    pickEmpty:
      'No print layouts to choose from yet. Use "Create a new print layout" above to make one.',
  },
  errors: {
    generic: 'Something went wrong',
    unauthorized: 'Sign in to continue',
    notFound: 'Not found',
    sessionExpired:
      'Your sign-in expired. Sign in again to see everything you have access to.',
  },
  addToFolder: {
    heading: 'Add {count, plural, one {# item} other {# items}} to a folder',
    searchPlaceholder: 'Search folders',
    noMatches: 'No folders match.',
    itemCount: '{count, plural, one {# item} other {# items}}',
  },
  areaSearch: {
    title: 'Search by area',
    hint: 'Pan and zoom; the list updates automatically.',
    close: 'Close area search',
    myLocation: 'My location',
    myLocationTitle: 'Center the map on your current location',
    padAreaBy: 'Pad area by',
    searching: 'Searching...',
    refreshNow: 'Refresh now',
  },
  dataPreview: {
    title: 'Data preview',
    eyebrow: 'Preview',
    openItem: 'Open item',
    closePreview: 'Close preview',
    layer: 'Layer',
    layerLabel: 'Layer:',
    table: 'table',
    tableSuffix: '(table)',
    noFeatures: 'No features in this layer.',
    featureCount: '{count, plural, one {# feature} other {# features}}',
    featureCountOverflow: '{count}+ of many features',
    fieldCount: '{count, plural, one {# field} other {# fields}}',
    overflowNotice:
      "Showing the first {limit} features. Open the item's map editor for the full attribute table.",
    upstreamError: 'Upstream returned an error',
    loadFailed: 'Could not load preview. Open the item to see details.',
  },
  filter: {
    filter: 'Filter',
    filterItems: 'Filter items',
    activeCount:
      '{count, plural, one {# filter active} other {# filters active}}',
    type: 'Type',
    clearTypes: 'Clear types',
    noItemsToFilter: 'No items in the current view to filter.',
    template: 'Template',
    owner: 'Owner',
    access: 'Access',
    area: 'Area',
    clearArea: 'Clear area',
    filterByArea: 'Filter by area...',
    filteringByArea: 'Filtering by area',
    clearAll: 'Clear all filters',
  },
  folders: {
    hide: 'Hide folders',
  },
  folderRail: {
    newButton: '+ New',
    collapse: 'Collapse folder',
    expand: 'Expand folder',
    folderNamePlaceholder: 'Folder name',
    emptyPrefix: 'No folders yet.',
    createOne: 'Create one',
    emptySuffix: 'to organize your items.',
    moveFailedTitle: 'Move failed',
    moveFailedMessage: 'Could not move item.',
  },
  folderMenu: {
    actionsFor: 'Actions for {folder}',
    moreActions: 'More actions',
    share: 'Share...',
    newSubfolder: 'New subfolder',
    trashTitle: 'Move folder to trash?',
    trashMessage:
      "Move \"{folder}\" to the recycle bin? The folder's contents stay where they are; only the folder arrangement is removed.",
    trashMessageCascade:
      'Move "{folder}" and the subfolders below to the recycle bin? Non-folder items inside stay where they are; only the folder arrangement is removed.',
    subfoldersAlsoTrashed:
      '{count, plural, one {# subfolder will also be moved to trash:} other {# subfolders will also be moved to trash:}}',
    andMore: '...and {count} more.',
    unlinkedItems:
      '{count, plural, one {# other item inside will lose its folder reference, but the item itself stays.} other {# other items inside will lose their folder reference, but the items themselves stay.}}',
    multiParentNote:
      "Subfolders that are also filed under another folder will survive this delete and aren't listed.",
    trashing: 'Trashing...',
    trashFailedTitle: 'Could not move to trash',
    trashFailedMessage: 'Move to trash failed: {status}',
  },
  field: {
    // Sidebar entry for the field catalog.
    nav: 'Field',
    qrAlt: 'QR code linking to this deployment',
    qrHint:
      'Point a phone camera at this to open the deployment on that device.',
    qrSignIn: 'You will be asked to sign in on the phone the first time.',
    copyLink: 'Copy link',
    copied: 'Copied',
    openOnPhone: 'Open on a phone',
  },
  // Offline queue rows the server refused for a reason a retry cannot
  // change. Shown from the field runtime header chip.
  fieldQueue: {
    rejectedChip: '{count, plural, one {# edit needs attention} other {# edits need attention}}',
    rejectedChipTitle:
      'The server refused these edits. Open to see why and retry or discard them.',
    rejectedTitle: 'Edits the server refused',
    rejectedIntro:
      'These edits were sent but not accepted, and sending them again unchanged would get the same answer. Fix what the message names and retry, or discard the edit.',
    rejectedEmpty: 'Nothing here. Every edit has been accepted.',
    op: {
      insert: 'New feature in {layer}',
      update: 'Change to a feature in {layer}',
      delete: 'Deletion in {layer}',
    },
    unknownLayer: 'a layer no longer in this deployment',
    noReason: 'The server did not say why.',
    retry: 'Retry',
    retryAll: 'Retry all {count}',
    discard: 'Discard',
    discardTitle: 'Discard this edit?',
    discardMessage:
      'It exists only on this device. Once discarded it cannot be recovered.',
    discardAction: 'Discard edit',
    close: 'Close',
  },
  itemDetail: {
    // Access pills. Plain English rather than the stored enum value:
    // "org" is not a word a reader should have to decode.
    accessPrivate: 'Private',
    accessOrg: 'Organization',
    accessPublic: 'Public',
    accessPrivateTitle: 'Only you and people you share it with',
    accessOrgTitle: 'Everyone signed in to this portal',
    accessPublicTitle: 'Anyone on the internet, no sign-in needed',
    licenseTitle: 'License: {license}',
    // Stats strip.
    statFeatures: 'Features',
    statGeometry: 'Shape',
    statCoordinates: 'Coordinates',
    statFields: 'Fields',
    statLayers: 'Layers',
    statUpdated: 'Updated',
    statFeaturesTitle:
      'Counted live, and limited to what you have access to, so it can be lower than the published total.',
    statCoordinatesTitle:
      'Stored as latitude and longitude (EPSG:4326). {source}',
    statCoordinatesFrom: 'Converted from {srs} when it was imported.',
    statCoordinatesNative: 'That is how it arrived.',
    statCoordinatesUnknown:
      'The source file did not say, so it was assumed to already be latitude and longitude.',
    statUnavailable: 'Not available',
    statMixed: 'Mixed',
    geometryPoint: 'Points',
    geometryLine: 'Lines',
    geometryPolygon: 'Areas',
    geometryNone: 'Table, no shapes',
    // Live preview.
    previewTitle: 'Preview',
    previewEmpty: 'Nothing to draw yet',
    previewEmptyHint:
      'This layer has no features with a location, so there is nothing to show on a map.',
    previewFailed: 'The preview could not be loaded',
    previewLoading: 'Loading the preview',
  },
  // #74 i18n backfill for the 2026-08-24 tabs + offline arc, which
  // shipped hardcoded English against the house rule.
  itemTabs: {
    overview: 'Overview',
    data: 'Data',
    structure: 'Structure',
    source: 'Source',
    metadata: 'Metadata',
    access: 'Access',
    sections: 'Item sections',
  },
  // #76: items shared with a group, on the group detail page.
  groupItems: {
    title: 'Shared with this group',
    empty: 'Nothing is shared with this group yet. Share an item to the group from its Access tab and it will show up here.',
    openItem: 'Open item details',
    removeAction: 'Remove from this group',
    removeTitle: 'Remove from group',
    removeBody:
      'Remove "{title}" from this group? Group members lose the access this share granted; the item itself is not touched.',
    removeConfirm: 'Remove',
    removed: 'Removed "{title}" from the group.',
    removeFailed: 'Could not remove the item: HTTP {status}.',
  },
  // #75: the housekeeping dashboard's tab strip.
  housekeepingTabs: {
    review: 'Review',
    cleanup: 'Cleanup',
    starters: 'Starters',
    schedule: 'Schedule',
    sections: 'Housekeeping sections',
  },
  // #73: the v3 data_layer editor, split across the Data and
  // Structure tabs.
  v3Editor: {
    structureTitle: 'Layer structure',
    structureIntro:
      'Edit layers, fields, domains and constraints here. Saving takes effect immediately; importing and browsing rows lives on the Data tab.',
  },
  metadataPanel: {
    description: 'Description',
    noDescription:
      'No description yet. A sentence about what this is and where it came from is the difference between an item someone reuses and one they re-create.',
    tags: 'Tags',
    noTags: 'No tags.',
    type: 'Type',
    owner: 'Owner',
    created: 'Created',
    updated: 'Updated',
    license: 'License',
    source: 'Source',
    sourceFormat: 'Source format',
    originalProjection: 'Original projection',
    itemId: 'Item ID',
    storageScope: 'Storage scope',
    storageScopeFor: 'Scope: {layer}',
    storageTable: 'Storage table',
    notRecorded: 'Not recorded',
    copyTitle: 'Copy {label}',
    formatGeojson: 'GeoJSON',
    formatGeoparquet: 'GeoParquet',
    formatKml: 'KML',
    formatKmz: 'KMZ',
    formatShapefile: 'Shapefile',
    formatGdb: 'File geodatabase',
    formatXlsx: 'Excel workbook',
    formatCsv: 'CSV',
    formatManual: 'Entered by hand',
    formatApi: 'Loaded through the API',
  },
  copyButton: {
    copy: 'Copy',
    copied: 'Copied',
  },
  offlineAreas: {
    title: 'Offline areas',
    intro:
      'The portal prepares one map file per area, so a whole county is a single download of a few megabytes rather than a million separate requests.',
    addArea: 'Add area',
    loading: 'Loading areas...',
    noneYet: 'No areas yet.',
    noneYetNoExtent:
      'Add some data to the deployed map first, so there is an extent to prepare.',
    noneYetHint:
      'Add one and collectors will be able to take this deployment offline.',
    extentSummary: 'about {width} by {height} miles',
    rebuildsEvery: 'rebuilds every {days} days',
    waiting: 'Waiting to start...',
    preparingCount: 'Preparing {count} tiles...',
    preparing: 'Preparing...',
    ready: 'Ready',
    builtOn: 'built {date}',
    buildFailed: 'Could not be prepared.',
    notPrepared: 'Not prepared yet.',
    prepareAgain: 'Prepare again',
    prepareNow: 'Prepare now',
    deleteArea: 'Delete area',
    deleteTitle: 'Delete this area?',
    deleteBody:
      'Collectors will no longer be able to download "{name}". Anything already on a device stays there.',
    name: 'Name',
    namePlaceholder: 'Summer survey, north crew...',
    detailLabel: 'How much detail',
    detailHint:
      'Collectors can always zoom in further than this. Past a point the map just stops adding new labels.',
    refreshLabel: 'Keep it up to date',
    refreshManual: 'Only when I ask',
    refreshWeekly: 'Weekly',
    refreshMonthly: 'Monthly',
    refreshQuarterly: 'Every three months',
    detailRoads: 'Roads and towns',
    detailRoadsHint: 'Smallest download',
    detailStreets: 'Local streets',
    detailPaths: 'Street names and paths',
    detailPathsHint: 'Recommended for field work',
    detailBuildings: 'Building outlines',
    detailBuildingsHint: 'Largest download',
    tooBig:
      'This area is too big at that detail level. Choose less detail, or split the deployment into more than one area.',
    sizeEstimate:
      'Covers {extent}. Roughly {size} to download. The exact figure is measured before anything is prepared.',
    cancel: 'Cancel',
    addAndPrepare: 'Add and prepare',
    saveFailed: 'Could not save the area: {status}',
    buildStartFailed: 'Could not start the build: {status}',
  },
  offlineBasemap: {
    preparedMap: 'Prepared map',
    preparedMaps: 'Prepared maps',
    onThisDevice: 'On this device',
    includedWithSize: '{size}, included in the download above',
    included: 'Included in the download above',
    removeFromDevice: 'Remove from this device',
    removeAria: 'Remove {name} from this device',
    explainer:
      'Your team lead prepared these maps, so they come down as single files rather than piece by piece, and they draw with no signal at all.',
    unsupported:
      'This browser cannot store maps offline. Try adding the app to your home screen.',
    preparedNoticeOne:
      'The map for this deployment is already prepared, so it comes down as one file.',
    preparedNoticeMany:
      'The maps for this deployment are already prepared, so they come down as single files.',
    downloadStopped:
      'Download stopped. Anything already saved is still on this device.',
  },
  itemMenu: {
    actions: 'Item actions',
    open: 'Open',
    responses: 'Responses',
    configure: 'Configure',
    previewData: 'Preview data',
    addToMap: 'Add to map',
    moveToFolder: 'Move to folder',
    removeFromFolder: 'Remove from this folder',
    removeFromNamedFolder: 'Remove from "{folder}"',
  },
  itemForm: {
    itemType: 'Item type',
    title: 'Title',
    titlePlaceholder: 'My layer, report, form...',
    titleRequired: 'Title is required.',
    description: 'Description',
    descriptionPlaceholder: "What is this, and who's it for?",
    tags: 'Tags',
    tagsPlaceholder: 'Comma separated, e.g. buildings, parcels, campus',
    tagsHint: 'Used for search and filtering.',
    thumbnail: 'Thumbnail',
    visibility: 'Visibility',
    visibilityHintCreate:
      'You can change this later and add explicit shares from the item detail page.',
    visibilityHintEdit:
      'Refine with per-user or per-group shares from the detail page.',
    license: 'License',
    licenseHintPrefix:
      "How others are allowed to reuse this item. Surfaced in the org's open-data catalog",
    licenseHintSuffix: 'for public items.',
    licenseCustomPlaceholder:
      'SPDX id or license URL (e.g. https://creativecommons.org/licenses/by/4.0/)',
    recipe: 'Recipe',
    pickSourceLayer: 'Pick a source data layer for this derived layer.',
    addPipelineStep: 'Add at least one tool step to the pipeline.',
    saveFailed: '{method} failed: {status} {detail}',
    saveChanges: 'Save changes',
    type: {
      map: { label: 'Map', desc: 'A basemap + overlay layers with styling.' },
      data_layer: {
        label: 'Data layer',
        desc: 'A shareable vector layer backed by PostGIS.',
      },
      arcgis_service: {
        label: 'ArcGIS service',
        desc: 'Live pointer at an ArcGIS MapServer or FeatureServer.',
      },
      form: {
        label: 'Form',
        desc: 'A collection form for fieldwork or survey data.',
      },
      web_app: {
        label: 'Web app',
        desc: 'A configurable app built from widgets.',
      },
      report_template: {
        label: 'Report template',
        desc: 'A document template that renders data.',
      },
      dashboard: {
        label: 'Dashboard',
        desc: 'Live panels showing feature data.',
      },
      file: {
        label: 'File',
        desc: 'Any uploaded file (PDF, image, zip, etc.).',
      },
    },
    access: {
      private: {
        label: 'Private',
        desc: 'Only you and people you share with.',
      },
      org: {
        label: 'Your organization',
        desc: 'Everyone with a login in your org.',
      },
      public: { label: 'Public', desc: 'Anyone on the internet.' },
    },
    licenseOption: {
      notSpecified: {
        label: 'Not specified',
        hint: 'Treated as "rights reserved"',
      },
      cc0: { label: 'CC0 (public domain)', hint: 'No rights reserved' },
      ccBy: { label: 'CC BY 4.0', hint: 'Reuse with attribution' },
      ccBySa: { label: 'CC BY-SA 4.0', hint: 'Attribution + share-alike' },
      ccByNc: { label: 'CC BY-NC 4.0', hint: 'Attribution, non-commercial' },
      oglUk: { label: 'UK Open Government Licence v3', hint: '' },
      odbl: { label: 'Open Database License 1.0', hint: '' },
      mit: { label: 'MIT', hint: 'Permissive; common for datasets too' },
      proprietary: {
        label: 'Proprietary / rights reserved',
        hint: 'Internal use only',
      },
      custom: { label: 'Custom…', hint: 'Specify your own value' },
    },
  },
  items: {
    share: 'Share',
    adding: 'Adding...',
    addToFolder: 'Add to folder',
    addToNamedFolder: 'Add to {folder}',
    addToFolderFailed: 'Add to folder failed',
    removeFromFolderFailed: 'Remove from folder failed',
    folderLoadFailed: 'Could not load folder: HTTP {status}',
    moveToTrash: 'Move to trash',
    movingProgress: 'Moving...',
    sharingProgress: 'Sharing...',
    searchFailed: 'Search failed',
    reassignFailed: 'Reassign failed',
    addingItemsTo: 'Adding items to:',
    addingItemsHint: 'Tick items below and click "Add to {folder}".',
    selected: 'selected',
    selectedItem: 'Selected item',
    clear: 'Clear',
    clearFilter: 'Clear {filter} filter',
    selectAll: 'Select all manageable items in this group',
    selectItem: 'Select {title}',
    reassignOwner: 'Reassign owner',
    reassignHeading: 'Reassign {count, plural, one {# item} other {# items}}',
    reassignSubheading:
      "Pick the new owner; each item's existing shares are preserved.",
    bulkTrashTitle: 'Move selected items to trash',
    bulkTrashHeading:
      'Move {count, plural, one {# item} other {# items}} to trash?',
    bulkTrashBody:
      'The selected {count, plural, one {item} other {items}} will be moved to the recycle bin. You can restore them from the "Recently deleted" page.',
    skippedHint:
      'Items where you are not the owner or an admin are skipped automatically.',
    bulkTrashNoneMoved:
      'No items moved to trash. You may not have admin rights on the selected items.',
    bulkTrashPartial:
      'Moved {done, plural, one {# item} other {# items}} to trash; skipped {skipped} (no admin rights).',
    bulkShareNoneWritten:
      'No shares were written. You may not have admin rights on the selected items.',
    bulkSharePartial:
      'Shared {done, plural, one {# item} other {# items}}; skipped {skipped} (no admin rights).',
    bulkAccessNoneUpdated:
      'No items were updated. You may not have admin rights on the selected items.',
    bulkAccessPartial:
      'Updated {done, plural, one {# item} other {# items}}; skipped {skipped} (no admin rights).',
    shareSelectedTitle: 'Share selected items',
    shareSelectedBody:
      'Each of the {count, plural, one {# selected item} other {# selected items}} gets its own share grant for the recipient you pick. Items where you are not the owner or an admin are skipped automatically.',
    shareTabPrincipal: 'User or group',
    shareTabOrg: 'Org',
    shareOrgBody:
      "Anyone signed into your organization will be able to see the {count, plural, one {# selected item} other {# selected items}}. This raises the item's access tier; existing user / group shares are kept intact.",
    sharePublicBody:
      "Anyone on the internet will be able to see the {count, plural, one {# selected item} other {# selected items}} without signing in. Use this for shareable map / viewer links. Items referenced by the selection (layers, basemaps, etc.) need to be public too; you'll be prompted to cascade after this completes.",
    geographicScope: 'Geographic scope',
    noBoundaryItems: 'No boundary items in this org yet',
    noScope: 'No scope (unrestricted)',
    geoScopeHint:
      'When set, viewers reaching these items via {via} only see features inside the boundary. Enforced at the API layer.',
    geoScopeViaOrg: 'your organization',
    geoScopeViaPublic: 'public access',
    recipient: 'Recipient',
    groupTag: 'group',
    searchUserOrGroup: 'Search for a user or group',
    noMatchingUsersOrGroups: 'No matching users or groups.',
    startTypingName: 'Start typing a name to search.',
    permission: 'Permission',
    permissionDesc: {
      view: 'See the item',
      download: 'See + export bulk data',
      edit: 'See + change content',
      admin: 'Full control, including sharing',
    },
    makeOrgVisible: 'Make org-visible',
    makePublic: 'Make public',
    areaBuffer: ', +{km}km buffer',
    areaLabel: 'centered at {center} (~{width}km wide{buffer})',
    summaryType: 'Type: {labels}',
    summaryTemplate: 'Template: {labels}',
    summaryArea: 'Area: {label}',
    cardView: 'Card view',
    cards: 'Cards',
    listView: 'List view',
    list: 'List',
    groupBy: 'Group by',
    groupNone: 'None',
    groupTypeOption: 'Type',
    groupAccessOption: 'Access',
    sortLabel: 'Sort',
    sort: {
      'updated-desc': 'Recently updated',
      'updated-asc': 'Least recently updated',
      'created-desc': 'Newest first',
      'created-asc': 'Oldest first',
      'title-asc': 'Name (A–Z)',
      'title-desc': 'Name (Z–A)',
    },
    itemCount: '{count, plural, one {# item} other {# items}}',
    filteredOfTotal: '{filtered} of {total}',
    noItemsMatch: 'No items match your filters.',
    colTitle: 'Title',
    colType: 'Type',
    colOwner: 'Owner',
    colUpdated: 'Updated',
    ownerYou: 'you',
    template: {
      editor: 'Editor',
      viewer: 'Viewer',
      custom: 'Custom',
    },
  },
  itemsPage: {
    eyebrow: 'Content',
    newItem: 'New item',
    openMap: 'Open a map',
    addItems: 'Add items',
    myItems: 'My items',
    allItems: 'All items',
    folderBreadcrumb: 'Folder breadcrumb',
    folderDetails: 'Folder details →',
    emptySearchTitle: 'No items match your search',
    emptySearchDescription:
      'Nothing in {scope} matches "{query}". Try a different term or clear the search.',
    scopeYourItems: 'your items',
    scopeSharedWithYou: 'items shared with you',
    emptyFolderTitle: '{folder} is empty',
    emptyFolderDescription:
      'Add existing items, create something new, or drag items here from the all-items view.',
    emptyMineTitle: 'No items yet',
    emptyMineDescription:
      'Create your first map, form, or data layer to get started.',
    emptySharedTitle: 'Nothing shared with you yet',
    emptySharedDescription:
      'When a teammate shares content with you or your group, it will show up here.',
    createAnItem: 'Create an item',
  },
  trash: {
    restore: 'Restore',
    restoring: 'Restoring',
    deleteForever: 'Delete forever',
    daysLeft: '{count, plural, one {# day left} other {# days left}}',
    restoreFailed: 'Restore failed: {status} {detail}',
    purgeFailed: 'Purge failed: {status} {detail}',
    purgeConfirmTitle: 'Permanently delete "{title}"?',
    purgeConfirmDescription:
      'This immediately removes the item and every share attached to it. For data layers this also drops the underlying data table. This cannot be undone.',
  },
  dialogs: {
    confirm: 'Confirm',
    typeToConfirmPrefix: 'Type',
    typeToConfirmSuffix: 'to confirm:',
  },
  dependents: {
    checking: 'Checking what depends on this...',
    checkFailed: 'Could not check dependents ({error}). Proceed with caution.',
    loadFailed: 'Could not load dependents.',
    referencedBy:
      '{count, plural, one {# other item references this} other {# other items reference these}}',
    trashHint:
      'Trashing removes the reference from each of them. You can restore from Recently deleted if you change your mind.',
    moreNotShown: '+{count} more not shown.',
  },
  accessMatrix: {
    intro:
      'These items power this composite at runtime. Each sharee needs view access on every row, or they will see broken layers when they open it.',
    filterPlaceholder: 'Filter dependency items...',
    countsSummary:
      '{items, plural, one {# item} other {# items}} · {sharees, plural, one {# sharee} other {# sharees}}',
    grantMissing:
      'Grant {count, plural, one {# missing access} other {# missing accesses}}',
    noGaps: 'No gaps',
    itemHeader: 'Item',
    principalType: {
      user: 'user',
      group: 'group',
    },
    noMatches: 'No items match the filter.',
    hasViewAccess: '{name} has view access',
    grantViewTo: 'Grant view to {name}',
    grantView: 'Grant view',
    cannotSee: '{name} cannot see this item',
    grantFailed: 'Grant failed',
    done: 'Done',
  },
  sharing: {
    sharing: 'Sharing',
    dialogLabel: 'Sharing for {title}',
    whoCanSee: 'Who can see this',
    saving: 'Saving',
    explicitShares: 'Explicit shares',
    noExplicitShares: 'No individual user or group shares.',
    manageSharing: 'Manage sharing',
    chipTitleShared:
      '{label} · shared with {count, plural, one {# principal} other {# principals}}',
    youSuffix: '{label} (you)',
    removePrincipal: 'Remove {label}',
    updateFailed: 'Could not update: {status}',
    removeFailed: 'Remove failed: {status}',
    access: {
      private: 'Private',
      org: 'Organization',
      public: 'Public',
    },
    permission: {
      view: 'View',
      download: 'Download',
      edit: 'Edit',
      admin: 'Admin',
    },
    expires: 'Expires',
    expired: 'Expired',
    neverExpires: 'Never expires',
    setExpiry: 'Set expiry',
    expiryDialogLabel: 'Share expiry',
    days: '{count, plural, one {# day} other {# days}}',
    set: 'Set',
  },
  picker: {
    noMatches: 'No matches.',
    startTyping: 'Start typing to search.',
    unavailable: 'unavailable',
  },
  cascade: {
    title: 'Make referenced items public too?',
    dialogLabel: 'Make referenced items public',
    body: "is now public, but it references items that are still private. Anonymous visitors won't see those layers until each one is also marked public.",
    loading: 'Loading referenced items...',
    loadFailed: 'Failed to load referenced items',
    partialFailure:
      '{failed} of {total} referenced items could not be made public. Try again or fix permissions.',
    skip: 'Skip',
    makePublic: 'Make {count, plural, one {# item} other {# items}} public',
  },
  cascadeRevert: {
    title: 'Revert referenced items from public too?',
    dialogLabel: 'Revert referenced items from public',
    body: "is no longer public. These referenced items are public only because of this one and aren't independently used by any other public item, so you can safely take them out of public access too. Items still powering another public map / app aren't shown.",
    loadFailed: 'Failed to load cascade-revert candidates',
    partialFailure:
      '{failed} of {total} referenced items could not be reverted. Try again or fix permissions.',
    revertButton:
      'Revert {count, plural, one {# item} other {# items}} to {tier}',
  },
  reassign: {
    newOwner: 'New owner',
    searchPlaceholder: 'Search a user in your organization…',
    pickOwner: 'Pick the new owner.',
    failed: 'Reassign failed',
    transferTo: 'Transfer to',
    keepAccessLegend: "Keep previous owner's access",
    keepView: 'View: previous owner can still see it',
    keepDownload: 'Download: previous owner can also export raw data',
    keepEdit: 'Edit: previous owner can still change it',
    keepAdmin: 'Admin: previous owner keeps full control',
    keepNone: 'None: previous owner loses access',
    reassign: 'Reassign',
  },
  theme: {
    label: 'Appearance',
    light: 'Light',
    dark: 'Dark',
    system: 'System',
  },
  adminBackup: {
    startFailed: 'The backup could not be started.',
    deleteFailed: 'The backup could not be deleted.',
    stopFailed: 'The backup could not be stopped.',
    stop: 'Stop',
    stopping: 'Stopping...',
    stopTitle:
      'Ask this backup to stop. Nothing is published until a backup finishes, so stopping is always safe.',
    fileMissing: 'File no longer on the server',
    fileMissingTitle:
      'This backup finished, but its file is no longer in the backup folder. It may have been moved, deleted by hand, or belong to an earlier restore of the database. It cannot be downloaded or restored.',
  },
  welcome: {
    title: 'Welcome to GratisGIS',
    intro: 'Your workspace is empty. Pick a starting point.',
    createMap: 'Create a map',
    createMapDesc: 'Start from a blank map on the default basemap.',
    uploadData: 'Upload data',
    uploadDataDesc: 'Bring in GeoJSON, Shapefile, or CSV as a data layer.',
    loadSample: 'Load sample data',
    loadSampleDesc:
      'Explore a ready-made Randolph County workspace: layers, maps, a form, apps, and a field survey.',
    loading: 'Loading sample data...',
    loaded: '{count, plural, one {# sample item created} other {# sample items created}}',
    allSkipped: 'Sample data is already loaded',
    failed: 'Could not load sample data',
    dismiss: 'Dismiss welcome panel',
  },
} as const;
