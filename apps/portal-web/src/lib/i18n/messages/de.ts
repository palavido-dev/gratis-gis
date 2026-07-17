// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 1.1 German catalog.
 *
 * Machine-translated seed (initial pass 2026-06-01). Native
 * speakers: please review and refine. Open a pull request with
 * fixes; the locale picker tags this locale "MT" until a native
 * speaker has signed off. See CONTRIBUTING-TRANSLATIONS.md.
 *
 * Conventions: standard German (Bundesdeutsch). Formal "Sie" for
 * user-addressing (matches the convention of professional GIS
 * software in German-speaking markets). Single-word button labels
 * use the infinitive ("Speichern," not "Speichere").
 */
import type { CatalogShape } from '../locales';

export const de: Partial<CatalogShape> = {
  common: {
    save: 'Speichern',
    cancel: 'Abbrechen',
    delete: 'Löschen',
    close: 'Schließen',
    edit: 'Bearbeiten',
    loading: 'Wird geladen…',
    backToItems: 'Zurück zu Elementen',
    settings: 'Einstellungen',
    language: 'Sprache',
  },
  nav: {
    items: 'Elemente',
    home: 'Startseite',
    admin: 'Verwaltung',
    profile: 'Profil',
    signOut: 'Abmelden',
    signIn: 'Anmelden',
    overview: 'Übersicht',
    folders: 'Ordner',
    groups: 'Gruppen',
    recentlyDeleted: 'Kürzlich gelöscht',
    users: 'Benutzer',
    landingPage: 'Startseite',
    backup: 'Sicherung',
    housekeeping: 'Wartung',
    notifications: 'Benachrichtigungen',
    fieldQueues: 'Feld-Warteschlangen',
    migrations: 'Migrationen',
  },
  shell: {
    notificationsLabel: 'Benachrichtigungen',
    navigation: 'Navigation',
    openNavigation: 'Navigation öffnen',
    closeNavigation: 'Navigation schließen',
  },
  search: {
    placeholder: 'Elemente suchen...',
    label: 'Elemente suchen',
  },
  help: {
    buttonTitle: 'Hilfe (jederzeit ? drücken)',
    openLabel: 'Hilfe öffnen',
  },
  newItem: {
    pageTitle: 'Neues Element erstellen',
    pageIntro:
      'Wählen Sie aus, was Sie erstellen, und füllen Sie dann die Details aus. Für Dienste und Uploads sammeln wir auf dem nächsten Bildschirm, was wir benötigen, damit das Element einsatzbereit ist.',
    createButton: 'Element erstellen',
    backButton: 'Zurück',
  },
  mapEditor: {
    legendButton: 'Legende',
    tableButton: 'Attributtabelle',
    markupButton: 'Markierungen',
    commentsButton: 'Kommentare',
    printButton: 'Diese Karte drucken',
    layerAccessButton: 'Ebenenzugriff',
    saveMapButton: 'Karte speichern',
    savedIndicator: 'Gespeichert',
  },
  presence: {
    youSuffix: ' (Sie)',
  },
  comments: {
    title: 'Kommentare',
    showResolved: 'Gelöste anzeigen',
    startThread: 'Neuen Thread starten...',
    post: 'Veröffentlichen',
    reply: 'Antworten...',
    resolve: 'Lösen',
    reopen: 'Wieder öffnen',
    threadCount: '{count, plural, one {# Thread} other {# Threads}}',
    noOpen:
      'Keine offenen Threads. Aktivieren Sie „Gelöste anzeigen", um geschlossene zu sehen.',
    noComments:
      'Noch keine Kommentare. Starten Sie die Unterhaltung unten.',
    signInPrompt: 'Melden Sie sich an, um diese Karte zu kommentieren.',
  },
  markup: {
    title: 'Markierungen',
    add: 'Markierung hinzufügen',
    empty:
      'Noch keine Markierungen. Fügen Sie einen Satz hinzu und setzen Sie dann Pins, um die Karte zu markieren.',
    dropPin: 'Pin in der Mitte setzen',
    signInPrompt:
      'Melden Sie sich an, um Markierungen zu dieser Karte hinzuzufügen.',
  },
  print: {
    chooserTitle: 'Diese Karte drucken',
    startSection: 'Neues Layout erstellen',
    startAction:
      'Neues Drucklayout erstellen, das mit dieser Karte verknüpft ist',
    startHint:
      'Öffnet den Drucklayout-Designer, in dem diese Karte bereits mit den Elementen Karte, Legende, Maßstab und Nordpfeil verbunden ist.',
    pickSection: 'Vorhandenes Layout verwenden',
    pickEmpty:
      'Noch keine Drucklayouts verfügbar. Verwenden Sie oben „Neues Layout erstellen", um eins zu erstellen.',
  },
  errors: {
    generic: 'Etwas ist schiefgelaufen',
    unauthorized: 'Melden Sie sich an, um fortzufahren',
    notFound: 'Nicht gefunden',
  },
  addToFolder: {
    heading: '{count, plural, one {# Element} other {# Elemente}} zu einem Ordner hinzufügen',
    searchPlaceholder: 'Ordner durchsuchen',
    noMatches: 'Kein Ordner stimmt überein.',
    itemCount: '{count, plural, one {# Element} other {# Elemente}}',
  },
  areaSearch: {
    title: 'Nach Gebiet suchen',
    hint: 'Verschieben und zoomen; die Liste aktualisiert sich automatisch.',
    close: 'Gebietssuche schließen',
    myLocation: 'Mein Standort',
    myLocationTitle: 'Karte auf Ihren aktuellen Standort zentrieren',
    padAreaBy: 'Gebiet erweitern um',
    searching: 'Suche läuft...',
    refreshNow: 'Jetzt aktualisieren',
  },
  dataPreview: {
    title: 'Datenvorschau',
    eyebrow: 'Vorschau',
    openItem: 'Element öffnen',
    closePreview: 'Vorschau schließen',
    layer: 'Layer',
    layerLabel: 'Layer:',
    table: 'Tabelle',
    tableSuffix: '(Tabelle)',
    noFeatures: 'Keine Features in diesem Layer.',
    featureCount: '{count, plural, one {# Feature} other {# Features}}',
    featureCountOverflow: '{count}+ von vielen Features',
    fieldCount: '{count, plural, one {# Feld} other {# Felder}}',
    overflowNotice:
      'Die ersten {limit} Features werden angezeigt. Öffnen Sie den Karteneditor des Elements für die vollständige Attributtabelle.',
    upstreamError: 'Die Quelle hat einen Fehler zurückgegeben',
    loadFailed:
      'Vorschau konnte nicht geladen werden. Öffnen Sie das Element für Details.',
  },
  filter: {
    filter: 'Filtern',
    filterItems: 'Elemente filtern',
    activeCount:
      '{count, plural, one {# Filter aktiv} other {# Filter aktiv}}',
    type: 'Typ',
    clearTypes: 'Typen zurücksetzen',
    noItemsToFilter: 'Keine Elemente in der aktuellen Ansicht zu filtern.',
    template: 'Vorlage',
    owner: 'Besitzer',
    area: 'Gebiet',
    clearArea: 'Gebiet zurücksetzen',
    filterByArea: 'Nach Gebiet filtern...',
    filteringByArea: 'Filterung nach Gebiet',
    clearAll: 'Alle Filter zurücksetzen',
  },
  folders: {
    hide: 'Ordner ausblenden',
  },
  folderRail: {
    newButton: '+ Neu',
    collapse: 'Ordner einklappen',
    expand: 'Ordner ausklappen',
    folderNamePlaceholder: 'Ordnername',
    emptyPrefix: 'Noch keine Ordner.',
    createOne: 'Erstellen Sie einen',
    emptySuffix: ', um Ihre Elemente zu organisieren.',
    moveFailedTitle: 'Verschieben fehlgeschlagen',
    moveFailedMessage: 'Element konnte nicht verschoben werden.',
  },
  folderMenu: {
    actionsFor: 'Aktionen für {folder}',
    moreActions: 'Weitere Aktionen',
    share: 'Teilen...',
    newSubfolder: 'Neuer Unterordner',
    trashTitle: 'Ordner in den Papierkorb verschieben?',
    trashMessage:
      '"{folder}" in den Papierkorb verschieben? Der Inhalt des Ordners bleibt, wo er ist; nur die Ordnerstruktur wird entfernt.',
    trashMessageCascade:
      '"{folder}" und die unten aufgeführten Unterordner in den Papierkorb verschieben? Elemente, die keine Ordner sind, bleiben, wo sie sind; nur die Ordnerstruktur wird entfernt.',
    subfoldersAlsoTrashed:
      '{count, plural, one {# Unterordner wird ebenfalls in den Papierkorb verschoben:} other {# Unterordner werden ebenfalls in den Papierkorb verschoben:}}',
    andMore: '...und {count} weitere.',
    unlinkedItems:
      '{count, plural, one {# weiteres Element darin verliert seine Ordnerreferenz, das Element selbst bleibt aber erhalten.} other {# weitere Elemente darin verlieren ihre Ordnerreferenz, die Elemente selbst bleiben aber erhalten.}}',
    multiParentNote:
      'Unterordner, die auch in einem anderen Ordner abgelegt sind, überstehen dieses Löschen und werden nicht aufgeführt.',
    trashing: 'Wird verschoben...',
    trashFailedTitle: 'Konnte nicht in den Papierkorb verschoben werden',
    trashFailedMessage: 'Verschieben in den Papierkorb fehlgeschlagen: {status}',
  },
  itemMenu: {
    actions: 'Elementaktionen',
    open: 'Öffnen',
    responses: 'Antworten',
    configure: 'Konfigurieren',
    previewData: 'Datenvorschau',
    moveToFolder: 'In Ordner verschieben',
    removeFromFolder: 'Aus diesem Ordner entfernen',
    removeFromNamedFolder: 'Aus "{folder}" entfernen',
  },
  itemForm: {
    itemType: 'Elementtyp',
    title: 'Titel',
    titlePlaceholder: 'Mein Layer, Bericht, Formular...',
    titleRequired: 'Titel ist erforderlich.',
    description: 'Beschreibung',
    descriptionPlaceholder: 'Was ist das, und für wen ist es?',
    tags: 'Schlagwörter',
    tagsPlaceholder: 'Kommagetrennt, z. B. Gebäude, Flurstücke, Campus',
    tagsHint: 'Wird für Suche und Filterung verwendet.',
    thumbnail: 'Vorschaubild',
    visibility: 'Sichtbarkeit',
    visibilityHintCreate:
      'Sie können dies später ändern und explizite Freigaben auf der Detailseite des Elements hinzufügen.',
    visibilityHintEdit:
      'Verfeinern Sie mit Freigaben pro Benutzer oder Gruppe auf der Detailseite.',
    license: 'Lizenz',
    licenseHintPrefix:
      'Wie andere dieses Element weiterverwenden dürfen. Erscheint im Open-Data-Katalog der Organisation',
    licenseHintSuffix: 'für öffentliche Elemente.',
    licenseCustomPlaceholder:
      'SPDX-Id oder Lizenz-URL (z. B. https://creativecommons.org/licenses/by/4.0/)',
    recipe: 'Rezept',
    pickSourceLayer:
      'Wählen Sie einen Quell-Datenlayer für diesen abgeleiteten Layer.',
    addPipelineStep:
      'Fügen Sie der Pipeline mindestens einen Werkzeugschritt hinzu.',
    saveFailed: '{method} fehlgeschlagen: {status} {detail}',
    saveChanges: 'Änderungen speichern',
    type: {
      map: {
        label: 'Karte',
        desc: 'Eine Grundkarte + überlagerte Layer mit Styling.',
      },
      data_layer: {
        label: 'Datenlayer',
        desc: 'Ein teilbarer Vektorlayer auf PostGIS-Basis.',
      },
      arcgis_service: {
        label: 'ArcGIS-Dienst',
        desc: 'Live-Verweis auf einen ArcGIS MapServer oder FeatureServer.',
      },
      form: {
        label: 'Formular',
        desc: 'Ein Erfassungsformular für Feldarbeit oder Umfragen.',
      },
      web_app: {
        label: 'Web-App',
        desc: 'Eine konfigurierbare App aus Widgets.',
      },
      report_template: {
        label: 'Berichtsvorlage',
        desc: 'Eine Dokumentvorlage, die Daten rendert.',
      },
      dashboard: {
        label: 'Dashboard',
        desc: 'Live-Panels mit Feature-Daten.',
      },
      file: {
        label: 'Datei',
        desc: 'Jede hochgeladene Datei (PDF, Bild, Zip usw.).',
      },
    },
    access: {
      private: {
        label: 'Privat',
        desc: 'Nur Sie und Personen, mit denen Sie teilen.',
      },
      org: {
        label: 'Ihre Organisation',
        desc: 'Alle mit einem Konto in Ihrer Organisation.',
      },
      public: { label: 'Öffentlich', desc: 'Jeder im Internet.' },
    },
    licenseOption: {
      notSpecified: {
        label: 'Nicht angegeben',
        hint: 'Wird als "alle Rechte vorbehalten" behandelt',
      },
      cc0: { label: 'CC0 (gemeinfrei)', hint: 'Keine Rechte vorbehalten' },
      ccBy: {
        label: 'CC BY 4.0',
        hint: 'Weiterverwendung mit Namensnennung',
      },
      ccBySa: {
        label: 'CC BY-SA 4.0',
        hint: 'Namensnennung + Weitergabe unter gleichen Bedingungen',
      },
      ccByNc: {
        label: 'CC BY-NC 4.0',
        hint: 'Namensnennung, nicht kommerziell',
      },
      oglUk: {
        label: 'UK Open Government Licence v3',
        hint: '',
      },
      odbl: { label: 'Open Database License 1.0', hint: '' },
      mit: {
        label: 'MIT',
        hint: 'Permissiv; auch für Datensätze verbreitet',
      },
      proprietary: {
        label: 'Proprietär / alle Rechte vorbehalten',
        hint: 'Nur interne Nutzung',
      },
      custom: {
        label: 'Benutzerdefiniert…',
        hint: 'Geben Sie einen eigenen Wert an',
      },
    },
  },
  items: {
    share: 'Teilen',
    adding: 'Wird hinzugefügt...',
    addToFolder: 'Zu Ordner hinzufügen',
    addToNamedFolder: 'Zu {folder} hinzufügen',
    addToFolderFailed: 'Hinzufügen zum Ordner fehlgeschlagen',
    removeFromFolderFailed: 'Entfernen aus dem Ordner fehlgeschlagen',
    folderLoadFailed: 'Ordner konnte nicht geladen werden: HTTP {status}',
    moveToTrash: 'In den Papierkorb verschieben',
    movingProgress: 'Wird verschoben...',
    sharingProgress: 'Wird geteilt...',
    searchFailed: 'Suche fehlgeschlagen',
    reassignFailed: 'Neuzuweisung fehlgeschlagen',
    addingItemsTo: 'Elemente hinzufügen zu:',
    addingItemsHint:
      'Haken Sie unten Elemente an und klicken Sie auf "Zu {folder} hinzufügen".',
    selected: 'ausgewählt',
    selectedItem: 'Ausgewähltes Element',
    clear: 'Zurücksetzen',
    clearFilter: 'Filter {filter} zurücksetzen',
    selectAll: 'Alle verwaltbaren Elemente dieser Gruppe auswählen',
    selectItem: '{title} auswählen',
    reassignOwner: 'Besitzer neu zuweisen',
    reassignHeading:
      '{count, plural, one {# Element} other {# Elemente}} neu zuweisen',
    reassignSubheading:
      'Wählen Sie den neuen Besitzer; die bestehenden Freigaben jedes Elements bleiben erhalten.',
    bulkTrashTitle: 'Ausgewählte Elemente in den Papierkorb verschieben',
    bulkTrashHeading:
      '{count, plural, one {# Element} other {# Elemente}} in den Papierkorb verschieben?',
    bulkTrashBody:
      '{count, plural, one {Das ausgewählte Element wird in den Papierkorb verschoben.} other {Die ausgewählten Elemente werden in den Papierkorb verschoben.}} Sie können sie über die Seite "Kürzlich gelöscht" wiederherstellen.',
    skippedHint:
      'Elemente, bei denen Sie weder Besitzer noch Administrator sind, werden automatisch übersprungen.',
    bulkTrashNoneMoved:
      'Keine Elemente in den Papierkorb verschoben. Möglicherweise fehlen Ihnen Administratorrechte für die ausgewählten Elemente.',
    bulkTrashPartial:
      '{done} Elemente in den Papierkorb verschoben; {skipped} übersprungen (keine Administratorrechte).',
    bulkShareNoneWritten:
      'Keine Freigaben geschrieben. Möglicherweise fehlen Ihnen Administratorrechte für die ausgewählten Elemente.',
    bulkSharePartial:
      '{done} Elemente geteilt; {skipped} übersprungen (keine Administratorrechte).',
    bulkAccessNoneUpdated:
      'Keine Elemente aktualisiert. Möglicherweise fehlen Ihnen Administratorrechte für die ausgewählten Elemente.',
    bulkAccessPartial:
      '{done} Elemente aktualisiert; {skipped} übersprungen (keine Administratorrechte).',
    shareSelectedTitle: 'Ausgewählte Elemente teilen',
    shareSelectedBody:
      'Jedes der {count} ausgewählten Elemente erhält eine eigene Freigabe für den gewählten Empfänger. Elemente, bei denen Sie weder Besitzer noch Administrator sind, werden automatisch übersprungen.',
    shareTabPrincipal: 'Benutzer oder Gruppe',
    shareTabOrg: 'Org.',
    shareOrgBody:
      'Jeder, der in Ihrer Organisation angemeldet ist, kann die {count} ausgewählten Elemente sehen. Dies hebt die Zugriffsstufe des Elements an; bestehende Benutzer- / Gruppenfreigaben bleiben erhalten.',
    sharePublicBody:
      'Jeder im Internet kann die {count} ausgewählten Elemente ohne Anmeldung sehen. Verwenden Sie dies für teilbare Karten- / Viewer-Links. Von der Auswahl referenzierte Elemente (Layer, Grundkarten usw.) müssen ebenfalls öffentlich sein; Sie werden nach Abschluss zur Kaskadierung aufgefordert.',
    geographicScope: 'Geografischer Geltungsbereich',
    noBoundaryItems: 'Noch keine Grenzelemente in dieser Organisation',
    noScope: 'Kein Geltungsbereich (uneingeschränkt)',
    geoScopeHint:
      'Wenn gesetzt, sehen Betrachter, die über {via} auf diese Elemente zugreifen, nur Features innerhalb der Grenze. Wird auf API-Ebene durchgesetzt.',
    geoScopeViaOrg: 'Ihre Organisation',
    geoScopeViaPublic: 'öffentlichen Zugriff',
    recipient: 'Empfänger',
    groupTag: 'Gruppe',
    searchUserOrGroup: 'Nach einem Benutzer oder einer Gruppe suchen',
    noMatchingUsersOrGroups: 'Keine passenden Benutzer oder Gruppen.',
    startTypingName: 'Beginnen Sie mit der Eingabe eines Namens.',
    permission: 'Berechtigung',
    permissionDesc: {
      view: 'Das Element sehen',
      download: 'Sehen + Massendaten exportieren',
      edit: 'Sehen + Inhalte ändern',
      admin: 'Volle Kontrolle, einschließlich Teilen',
    },
    makeOrgVisible: 'Für Org. sichtbar machen',
    makePublic: 'Öffentlich machen',
    areaBuffer: ', +{km} km Puffer',
    areaLabel: 'zentriert auf {center} (~{width} km breit{buffer})',
    summaryType: 'Typ: {labels}',
    summaryTemplate: 'Vorlage: {labels}',
    summaryArea: 'Gebiet: {label}',
    cardView: 'Kartenansicht',
    cards: 'Karten',
    listView: 'Listenansicht',
    list: 'Liste',
    groupBy: 'Gruppieren nach',
    groupNone: 'Keine',
    groupTypeOption: 'Typ',
    groupAccessOption: 'Zugriff',
    sortLabel: 'Sortieren',
    sort: {
      'updated-desc': 'Zuletzt aktualisiert',
      'updated-asc': 'Am längsten nicht aktualisiert',
      'created-desc': 'Neueste zuerst',
      'created-asc': 'Älteste zuerst',
      'title-asc': 'Name (A–Z)',
      'title-desc': 'Name (Z–A)',
    },
    itemCount: '{count, plural, one {# Element} other {# Elemente}}',
    filteredOfTotal: '{filtered} von {total}',
    noItemsMatch: 'Keine Elemente entsprechen Ihren Filtern.',
    colTitle: 'Titel',
    colType: 'Typ',
    colOwner: 'Besitzer',
    colUpdated: 'Aktualisiert',
    ownerYou: 'Sie',
    template: {
      editor: 'Editor',
      viewer: 'Viewer',
      custom: 'Benutzerdefiniert',
    },
  },
  itemsPage: {
    eyebrow: 'Inhalt',
    newItem: 'Neues Element',
    myItems: 'Meine Elemente',
    allItems: 'Alle Elemente',
    folderBreadcrumb: 'Ordnerpfad',
    folderDetails: 'Ordnerdetails →',
    emptySearchTitle: 'Keine Elemente entsprechen Ihrer Suche',
    emptySearchDescription:
      'Nichts in {scope} entspricht "{query}". Versuchen Sie einen anderen Begriff oder löschen Sie die Suche.',
    scopeYourItems: 'Ihren Elementen',
    scopeSharedWithYou: 'den mit Ihnen geteilten Elementen',
    emptyFolderTitle: '{folder} ist leer',
    emptyFolderDescription:
      'Verwenden Sie "Elemente hinzufügen" auf der Ordner-Detailseite oder ziehen Sie Elemente aus der Ansicht aller Elemente hierher.',
    emptyMineTitle: 'Noch keine Elemente',
    emptyMineDescription:
      'Erstellen Sie Ihre erste Karte, Ihr erstes Formular oder Ihren ersten Datenlayer, um loszulegen.',
    emptySharedTitle: 'Noch nichts mit Ihnen geteilt',
    emptySharedDescription:
      'Wenn Kollegen Inhalte mit Ihnen oder Ihrer Gruppe teilen, erscheinen sie hier.',
    createAnItem: 'Element erstellen',
  },
  trash: {
    restore: 'Wiederherstellen',
    restoring: 'Wird wiederhergestellt',
    deleteForever: 'Endgültig löschen',
    daysLeft: '{count, plural, one {noch # Tag} other {noch # Tage}}',
    restoreFailed: 'Wiederherstellung fehlgeschlagen: {status} {detail}',
    purgeFailed: 'Löschen fehlgeschlagen: {status} {detail}',
    purgeConfirmTitle: '"{title}" endgültig löschen?',
    purgeConfirmDescription:
      'Dies entfernt das Element und alle zugehörigen Freigaben sofort. Bei Datenlayern wird auch die zugrunde liegende Datentabelle gelöscht. Dies kann nicht rückgängig gemacht werden.',
  },
  dialogs: {
    confirm: 'Bestätigen',
    typeToConfirmPrefix: 'Geben Sie',
    typeToConfirmSuffix: 'zur Bestätigung ein:',
  },
  dependents: {
    checking: 'Es wird geprüft, was hiervon abhängt...',
    checkFailed:
      'Abhängige Elemente konnten nicht geprüft werden ({error}). Mit Vorsicht fortfahren.',
    loadFailed: 'Abhängige Elemente konnten nicht geladen werden.',
    referencedBy:
      '{count, plural, one {# weiteres Element referenziert dies} other {# weitere Elemente referenzieren diese}}',
    trashHint:
      'Das Verschieben in den Papierkorb entfernt die Referenz aus jedem davon. Sie können über Kürzlich gelöscht wiederherstellen, falls Sie es sich anders überlegen.',
    moreNotShown: '+{count} weitere nicht angezeigt.',
  },
  accessMatrix: {
    intro:
      'Diese Elemente treiben dieses zusammengesetzte Element zur Laufzeit an. Jeder Empfänger braucht Lesezugriff auf jede Zeile, sonst sieht er beim Öffnen defekte Layer.',
    filterPlaceholder: 'Abhängigkeitselemente filtern...',
    countsSummary:
      '{items, plural, one {# Element} other {# Elemente}} · {sharees, plural, one {# Empfänger} other {# Empfänger}}',
    grantMissing:
      '{count, plural, one {# fehlenden Zugriff gewähren} other {# fehlende Zugriffe gewähren}}',
    noGaps: 'Keine Lücken',
    itemHeader: 'Element',
    principalType: {
      user: 'Benutzer',
      group: 'Gruppe',
    },
    noMatches: 'Keine Elemente entsprechen dem Filter.',
    hasViewAccess: '{name} hat Lesezugriff',
    grantViewTo: 'Lesezugriff für {name} gewähren',
    grantView: 'Lesezugriff gewähren',
    cannotSee: '{name} kann dieses Element nicht sehen',
    grantFailed: 'Gewähren fehlgeschlagen',
    done: 'Fertig',
  },
  sharing: {
    sharing: 'Freigabe',
    dialogLabel: 'Freigabe für {title}',
    whoCanSee: 'Wer kann das sehen',
    saving: 'Wird gespeichert',
    explicitShares: 'Explizite Freigaben',
    noExplicitShares: 'Keine individuellen Benutzer- oder Gruppenfreigaben.',
    manageSharing: 'Freigabe verwalten',
    chipTitleShared:
      '{label} · geteilt mit {count, plural, one {# Empfänger} other {# Empfängern}}',
    youSuffix: '{label} (Sie)',
    removePrincipal: '{label} entfernen',
    updateFailed: 'Aktualisierung nicht möglich: {status}',
    removeFailed: 'Entfernen fehlgeschlagen: {status}',
    access: {
      private: 'Privat',
      org: 'Organisation',
      public: 'Öffentlich',
    },
    permission: {
      view: 'Ansehen',
      download: 'Herunterladen',
      edit: 'Bearbeiten',
      admin: 'Verwalten',
    },
    expires: 'Läuft ab',
    expired: 'Abgelaufen',
    neverExpires: 'Läuft nie ab',
    setExpiry: 'Ablauf festlegen',
    expiryDialogLabel: 'Ablauf der Freigabe',
    days: '{count, plural, one {# Tag} other {# Tage}}',
    set: 'Festlegen',
  },
  picker: {
    noMatches: 'Keine Treffer.',
    startTyping: 'Beginnen Sie mit der Eingabe, um zu suchen.',
    unavailable: 'nicht verfügbar',
  },
  cascade: {
    title: 'Referenzierte Elemente ebenfalls öffentlich machen?',
    dialogLabel: 'Referenzierte Elemente öffentlich machen',
    body: 'ist jetzt öffentlich, referenziert aber Elemente, die noch privat sind. Anonyme Besucher sehen diese Layer erst, wenn jedes davon ebenfalls als öffentlich markiert ist.',
    loading: 'Referenzierte Elemente werden geladen...',
    loadFailed: 'Referenzierte Elemente konnten nicht geladen werden',
    partialFailure:
      '{failed} von {total} referenzierten Elementen konnten nicht öffentlich gemacht werden. Versuchen Sie es erneut oder korrigieren Sie die Berechtigungen.',
    skip: 'Überspringen',
    makePublic:
      '{count, plural, one {# Element öffentlich machen} other {# Elemente öffentlich machen}}',
  },
  cascadeRevert: {
    title: 'Referenzierte Elemente ebenfalls aus dem öffentlichen Zugriff nehmen?',
    dialogLabel: 'Referenzierte Elemente aus dem öffentlichen Zugriff nehmen',
    body: 'ist nicht mehr öffentlich. Diese referenzierten Elemente sind nur wegen diesem öffentlich und werden von keinem anderen öffentlichen Element unabhängig genutzt; Sie können sie also gefahrlos aus dem öffentlichen Zugriff nehmen. Elemente, die noch eine andere öffentliche Karte / App antreiben, werden nicht angezeigt.',
    loadFailed: 'Kandidaten für die Rücknahme konnten nicht geladen werden',
    partialFailure:
      '{failed} von {total} referenzierten Elementen konnten nicht zurückgenommen werden. Versuchen Sie es erneut oder korrigieren Sie die Berechtigungen.',
    revertButton:
      '{count, plural, one {# Element} other {# Elemente}} auf {tier} zurücksetzen',
  },
  reassign: {
    newOwner: 'Neuer Besitzer',
    searchPlaceholder: 'Suchen Sie einen Benutzer Ihrer Organisation…',
    pickOwner: 'Wählen Sie den neuen Besitzer.',
    failed: 'Neuzuweisung fehlgeschlagen',
    transferTo: 'Übertragen an',
    keepAccessLegend: 'Zugriff des bisherigen Besitzers behalten',
    keepView: 'Ansehen: der bisherige Besitzer kann es weiterhin sehen',
    keepDownload:
      'Herunterladen: der bisherige Besitzer kann auch Rohdaten exportieren',
    keepEdit: 'Bearbeiten: der bisherige Besitzer kann es weiterhin ändern',
    keepAdmin:
      'Verwalten: der bisherige Besitzer behält die volle Kontrolle',
    keepNone: 'Keiner: der bisherige Besitzer verliert den Zugriff',
    reassign: 'Neu zuweisen',
  },
  theme: {
    label: 'Erscheinungsbild',
    light: 'Hell',
    dark: 'Dunkel',
    system: 'System',
  },
  welcome: {
    title: 'Willkommen bei GratisGIS',
    intro: 'Ihr Arbeitsbereich ist leer. Wählen Sie einen Startpunkt.',
    createMap: 'Karte erstellen',
    createMapDesc: 'Beginnen Sie mit einer leeren Karte auf der Standard-Grundkarte.',
    uploadData: 'Daten hochladen',
    uploadDataDesc: 'Importieren Sie GeoJSON, Shapefile oder CSV als Datenlayer.',
    loadSample: 'Beispieldaten laden',
    loadSampleDesc:
      'Erkunden Sie einen fertigen Randolph-County-Arbeitsbereich: Layer, Karten, ein Formular, Apps und eine Felderhebung.',
    loading: 'Beispieldaten werden geladen...',
    loaded: '{count, plural, one {# Beispielelement erstellt} other {# Beispielelemente erstellt}}',
    allSkipped: 'Beispieldaten sind bereits geladen',
    failed: 'Beispieldaten konnten nicht geladen werden',
    dismiss: 'Willkommensbereich ausblenden',
  },
};
