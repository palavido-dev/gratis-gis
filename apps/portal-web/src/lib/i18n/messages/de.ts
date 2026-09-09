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
    gettingStarted: 'Erste Schritte',
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
    viewerBlocked:
      'Ihr Konto hat die Rolle Betrachter. Damit können Sie Elemente öffnen und herunterladen, aber nicht erstellen. Eine Organisationsadministratorin kann Ihre Rolle ändern oder Ihnen allein die Veröffentlichungsberechtigung erteilen.',
  },
  newItemJob: {
    data_layer:
      'Beginnen Sie hier, wenn Sie eine Tabelle, ein Shapefile oder eine GeoJSON-Datei hochladen möchten.',
    map: 'Beginnen Sie hier, um bereits hochgeladene Daten auf eine Karte zu bringen und zu teilen.',
    form: 'Beginnen Sie hier, wenn Personen über einen Link, den Sie ihnen schicken, einzeln Antworten eingeben sollen.',
    data_collection:
      'Beginnen Sie hier, wenn ein Team vom Handy aus, auch offline, auf einer Karte festhalten soll, was es vorfindet.',
  },
  metadataXml: {
    intro:
      'Titel, Beschreibung und Schlagwörter aus einer {term}-Datei vorbelegen, wie sie ArcGIS, QGIS oder ein öffentlicher Datenkatalog zusammen mit einem Datensatz exportiert. Erkennt ISO 19115, FGDC CSDGM und Dublin Core.',
    term: 'Metadaten-XML',
    importTitle:
      'Eine von ArcGIS, QGIS oder einem Datenkatalog exportierte Metadaten-XML-Datei (ISO 19115, FGDC CSDGM oder Dublin Core) importieren, um die Felder unten vorzubelegen',
  },
  layerBuilder: {
    tableName: 'Tabellenname',
    tableNameTitle:
      'Der Name dieses Layers in der Datenbank und in Webadressen. Kleinbuchstaben, mit Unterstrichen statt Leerzeichen.',
    dropToImport: 'Zum Importieren ablegen.',
    dropHint: 'Legen Sie hier eine Datei ab oder klicken Sie, um eine auszuwählen.',
    importUsual:
      'Üblich ist eine als CSV gespeicherte Tabelle mit einer Spalte für den Breitengrad und einer für den Längengrad.',
    importAlso:
      'Außerdem: TSV · GeoJSON · GeoParquet (.parquet) · KML / KMZ (Google Earth) · GeoPackage (.gpkg, nur Vektortabellen) · Shapefile (.zip) · File Geodatabase (.gdb.zip)',
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
  featureEdit: {
    groupLabel: 'Bearbeiten',
    editShape: 'Geometrie bearbeiten',
    addFeature: 'Feature hinzufügen',
    deleteFeature: 'Feature löschen',
    layerToAddTo: 'Ziel-Layer',
    snappingOn: 'Fangen ein',
    snappingOff: 'Fangen aus',
    hintEdit:
      'Klicken Sie auf ein Feature in einem bearbeitbaren Layer, um seine Stützpunkte zu verschieben.',
    hintLoading: 'Feature wird geladen...',
    hintDelete:
      'Klicken Sie auf ein Feature in einem bearbeitbaren Layer, um es zu löschen.',
    hintAddPoint: 'Klicken Sie auf die Karte, um das Feature zu platzieren.',
    hintAddPath:
      'Klicken Sie, um Stützpunkte hinzuzufügen; doppelklicken Sie oder klicken Sie auf den ersten Stützpunkt, um abzuschließen.',
    editingIn:
      'Feature in {layer} wird bearbeitet. Ziehen Sie Stützpunkte; klicken Sie auf einen Mittelpunkt, um einen hinzuzufügen.',
    cancel: 'Abbrechen',
    saveShape: 'Geometrie speichern',
    shapeSaved: 'Geometrie gespeichert.',
    featureAdded: 'Feature hinzugefügt.',
    featureDeleted: 'Feature gelöscht.',
    newFeatureTitle: 'Neues Feature',
    newFeatureAttributes: 'Attribute des neuen Features',
    addAction: 'Feature hinzufügen',
    deleteConfirmTitle: 'Dieses Feature löschen?',
    deleteConfirmMessage:
      'Es wird aus "{layer}" entfernt. Das kann von hier aus nicht rückgängig gemacht werden.',
    deleteAction: 'Löschen',
    noStableId:
      'Dieses Feature hat keine stabile ID und kann hier nicht bearbeitet werden.',
    noGeometry: 'Dieser Layer hat keine Geometrie, die bearbeitet werden könnte.',
    notFound: 'Dieses Feature wurde auf dem Server nicht gefunden.',
    loadFailed: 'Feature konnte nicht geladen werden',
    saveFailed: 'Speichern fehlgeschlagen',
    deleteFailed: 'Löschen fehlgeschlagen',
    addFailed: 'Feature konnte nicht hinzugefügt werden',
    unnamedLayer: 'Layer',
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
    sessionExpired:
      'Ihre Anmeldung ist abgelaufen. Melden Sie sich erneut an, um wieder alles zu sehen, worauf Sie Zugriff haben.',
  },
  errorReason: {
    unknown: 'unbekannter Fehler',
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
    access: 'Zugriff',
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
  field: {
    nav: 'Feld',
    qrAlt: 'QR-Code mit Link zu dieser Bereitstellung',
    qrHint:
      'Richten Sie eine Handykamera darauf, um die Bereitstellung auf diesem Gerät zu öffnen.',
    qrSignIn: 'Beim ersten Mal werden Sie auf dem Handy aufgefordert, sich anzumelden.',
    copyLink: 'Link kopieren',
    copied: 'Kopiert',
    openOnPhone: 'Auf dem Handy öffnen',
  },
  fieldQueue: {
    rejectedChip:
      '{count, plural, one {# Änderung braucht Aufmerksamkeit} other {# Änderungen brauchen Aufmerksamkeit}}',
    rejectedChipTitle:
      'Der Server hat diese Änderungen abgelehnt. Öffnen Sie die Liste, um den Grund zu sehen und sie erneut zu senden oder zu verwerfen.',
    rejectedTitle: 'Vom Server abgelehnte Änderungen',
    rejectedIntro:
      'Diese Änderungen wurden gesendet, aber nicht angenommen, und ein unverändertes erneutes Senden würde dieselbe Antwort erhalten. Beheben Sie, was die Meldung nennt, und versuchen Sie es erneut, oder verwerfen Sie die Änderung.',
    rejectedEmpty: 'Hier ist nichts. Alle Änderungen wurden angenommen.',
    op: {
      insert: 'Neues Feature in {layer}',
      update: 'Änderung an einem Feature in {layer}',
      delete: 'Löschung in {layer}',
    },
    unknownLayer: 'einem Layer, der nicht mehr zu dieser Bereitstellung gehört',
    noReason: 'Der Server hat keinen Grund genannt.',
    retry: 'Erneut versuchen',
    retryAll: 'Alle {count} erneut versuchen',
    discard: 'Verwerfen',
    discardTitle: 'Diese Änderung verwerfen?',
    discardMessage:
      'Sie existiert nur auf diesem Gerät. Einmal verworfen, kann sie nicht wiederhergestellt werden.',
    discardAction: 'Änderung verwerfen',
    close: 'Schließen',
  },
  fieldAttachments: {
    heading: 'Fotos und Dateien',
    headingCount: 'Fotos und Dateien · {count}',
    add: 'Foto hinzufügen',
    emptyCanCapture:
      'Noch keine Fotos. Sie werden auf diesem Gerät aufbewahrt und mit dem Datensatz hochgeladen.',
    emptyReadOnly: 'Keine Fotos zu diesem Datensatz.',
    pendingBadge: 'Auf dem Gerät',
    pendingBadgeTitle: 'Wartet auf Upload',
    discardLabel: '{name} verwerfen',
    discardTitle: 'Diese Datei verwerfen?',
    discardMessage:
      '{name} wurde noch nicht hochgeladen. Beim Verwerfen wird die Datei von diesem Gerät entfernt und kann nicht wiederhergestellt werden.',
    discardAction: 'Verwerfen',
    quotaError:
      'Auf diesem Gerät ist kein Platz mehr für ein weiteres Foto. Synchronisieren Sie zuerst oder schaffen Sie Speicherplatz.',
    saveError: 'Datei konnte nicht gespeichert werden: {reason}',
  },
  fieldCollect: {
    cancel: 'Abbrechen',
    submit: 'Absenden',
    addTitle: 'Neues Feature: {layer}',
    editTitle: 'Feature bearbeiten: {layer}',
    addAria: '{layer} hinzufügen',
    editAria: '{layer} bearbeiten',
    discardTitle: 'Diesen Datensatz verwerfen?',
    discardMessage:
      'Sie haben Angaben eingegeben, die noch nicht gespeichert sind. Das Verwerfen kann nicht rückgängig gemacht werden.',
    discardAction: 'Verwerfen',
    discardCancel: 'Weiter bearbeiten',
  },
  fieldRuntime: {
    pickTypeSheet: 'Feature-Typ zum Hinzufügen wählen',
    featureDetailsSheet: 'Feature-Details',
    queueReadFailed: 'Die Offline-Warteschlange konnte nicht gelesen werden.',
  },
  fieldGps: {
    accuracy: 'GPS-Genauigkeit {meters} m',
    denied:
      'Der Standortzugriff ist blockiert. Erlauben Sie ihn in den Browsereinstellungen, um an Ihrer Position zu erfassen.',
    unavailable:
      'Der Standort ist auf diesem Gerät nicht verfügbar. Features werden in der Kartenmitte platziert.',
  },
  fieldOffline: {
    partial: 'Unvollständig. Nicht heruntergeladen: {missing}.',
    partialOutOfSpace:
      'Unvollständig, der Speicherplatz ist ausgegangen. Nicht heruntergeladen: {missing}.',
    partialMissingMore: '{missing} und {count} weitere',
    quotaTitle: 'Nicht genug Speicherplatz für diesen Download',
    quotaBody:
      'Dieser Download braucht etwa {needed}, und es fehlen ~{short}. Geben Sie zwischengespeicherte Bereitstellungen oder Gerätespeicher frei oder verringern Sie die Detailstufe, und versuchen Sie es erneut.',
    identityTitle: 'Nicht synchronisierte Arbeit eines anderen Kontos',
    identityBody:
      'Auf diesem Gerät liegen {records, plural, one {# nicht synchronisierter Datensatz} other {# nicht synchronisierte Datensätze}} und {files, plural, one {# Foto} other {# Fotos}}, die von einem anderen Konto erfasst wurden. Sie haben den Server nicht erreicht.',
    identityKeepExplain:
      'Behalten Sie sie hier, dann bleiben sie auf diesem Gerät geparkt, tauchen nicht in Ihren Synchronisierungszählern auf und werden gesendet, sobald sich dieses Konto wieder anmeldet.',
    identityRemoveExplain:
      'Entfernen Sie sie, dann werden sie von diesem Gerät gelöscht. Nirgendwo sonst gibt es eine Kopie.',
    identityKeep: 'Hier behalten',
    identityRemove: 'Von diesem Gerät entfernen',
    identityRemoved:
      '{records, plural, one {# Datensatz} other {# Datensätze}} und {files, plural, one {# Foto} other {# Fotos}} von diesem Gerät entfernt.',
    identityRemoveFailed:
      'Die Daten des anderen Kontos konnten nicht entfernt werden.',
    removeWillLose:
      '{count, plural, one {# nicht synchronisierte Bearbeitung geht verloren.} other {# nicht synchronisierte Bearbeitungen gehen verloren.}}',
    removeWillLoseOthers:
      '{count, plural, one {# davon gehört einem anderen Konto.} other {# davon gehören einem anderen Konto.}}',
  },
  offlineMessage: {
    unknown:
      'Dieses Gerät hat etwas gemeldet, das dieses Portal nicht kennt ({code}).',
    download: {
      estimating: 'Downloadgröße wird geschätzt ...',
      estimated: 'Geschätzt ~{size}',
      fetchingLayer: 'Features von {layer} werden abgerufen ...',
      layerCached:
        '{layer}: {count, plural, one {# Feature} other {# Features}} zwischengespeichert',
      layerHttpError: '{layer} ist mit HTTP {status} fehlgeschlagen',
      layerMalformed: '{layer} hat eine fehlerhafte Antwort gesendet',
      layerOutOfSpace: 'Für {layer} ist der Speicherplatz ausgegangen',
      layerFailed: '{layer} ist fehlgeschlagen: {error}',
      fetchingForm: 'Formular {form} wird abgerufen ...',
      formHttpError: 'Formular {form} ist mit HTTP {status} fehlgeschlagen',
      formNoSchema: 'Formular {form}, das kein Schema hat',
      formFailed: 'Formular {form}',
      fetchingPickList: 'Auswahlliste {pickList} wird abgerufen ...',
      pickListHttpError:
        'Auswahlliste {pickList} ist mit HTTP {status} fehlgeschlagen',
      pickListNoData: 'Auswahlliste {pickList}, die keine Daten hat',
      pickListFailed: 'Auswahlliste {pickList}',
      basemapOne: 'Die Karte wird heruntergeladen ...',
      basemapNth: 'Karte {index} von {count} wird heruntergeladen ...',
      basemapOnePercent: 'Die Karte wird heruntergeladen: {percent} %',
      basemapNthPercent:
        'Karte {index} von {count} wird heruntergeladen: {percent} %',
      basemapOneMegabytes: 'Die Karte wird heruntergeladen: {megabytes} MB',
      basemapNthMegabytes:
        'Karte {index} von {count} wird heruntergeladen: {megabytes} MB',
      basemapOutOfSpace: 'Kartendownload fehlgeschlagen: kein Speicherplatz mehr',
      basemapFailed: 'Kartendownload fehlgeschlagen: {error}',
      basemapAreaMissing: 'die Karte für das Gebiet {area}',
      cachingTiles: 'Kacheln der Basiskarte werden zwischengespeichert ...',
      tilesProgress: 'Kacheln werden zwischengespeichert: {fetched}/{total}',
      tilesRefused: '{reason}',
      tilesRefusedGeneric:
        'Der Anbieter der Basiskarte erlaubt keine Offline-Downloads.',
      tilesCached:
        '{fetched} Kacheln zwischengespeichert ({failed} fehlgeschlagen)',
      tilesOutOfSpace:
        'Kachelspeicher: kein Speicherplatz mehr (wird fortgesetzt)',
      tilesFailed: 'Kachelspeicher: {error} (wird fortgesetzt)',
      tilesMissing:
        '{count, plural, one {# Kachel der Basiskarte} other {# Kacheln der Basiskarte}}',
      tilesMissingAll: 'die Kacheln der Basiskarte',
      saving: 'Bereitstellungsmanifest wird gespeichert ...',
      layers: '{count, plural, one {# Layer} other {# Layer}}',
      detailFeatures: '{count, plural, one {# Feature} other {# Features}}',
      detailForms: '{count, plural, one {# Formular} other {# Formulare}}',
      detailPickLists:
        '{count, plural, one {# Auswahlliste} other {# Auswahllisten}}',
      done: '{layers} zwischengespeichert ({detail}).',
      doneEmpty:
        '{layers} zwischengespeichert. Die Synchronisierung bleibt aktuell, sobald Features hinzukommen.',
      donePartial: 'Unvollständig. Nicht heruntergeladen: {missing}. {summary}',
      donePartialOutOfSpace:
        'Unvollständig, der Speicherplatz ist ausgegangen. Nicht heruntergeladen: {missing}. Geben Sie Speicherplatz frei und laden Sie erneut herunter.',
      missingMore: '{missing} und {count} weitere',
      failed: 'Download fehlgeschlagen',
    },
    sync: {
      networkUnavailable: 'Keine Verbindung.',
      networkUnavailableDetail: 'Keine Verbindung: {error}',
      unknownOp:
        'Diese Änderung nutzt einen Vorgang, den diese App-Version nicht kennt ({op}).',
      fileTooLarge:
        '{fileName} ist {sizeMb} MB groß, das Limit liegt bei {limitMb} MB.',
      serverRefused: '{serverMessage}',
      serverRefusedWithStatus: '{serverMessage} ({status})',
      requestFailed: 'Der Server hat diese Änderung nicht angenommen ({status}).',
      attachmentPresignFailed:
        'Der Datei-Upload konnte nicht gestartet werden ({status}).',
      attachmentUploadFailed:
        'Die Datei konnte nicht hochgeladen werden ({status}).',
      attachmentRegisterFailed:
        'Die Datei wurde hochgeladen, aber das Portal hat sie nicht erfasst ({status}).',
      unexpected: 'Etwas ist schiefgelaufen: {error}',
    },
  },
  signOut: {
    unsyncedTitle: 'Mit nicht synchronisierten Änderungen abmelden?',
    unsyncedMessage:
      '{count, plural, one {# Änderung auf diesem Gerät hat den Server noch nicht erreicht. Sie bleibt auf diesem Gerät, aber niemand sonst kann sie für Sie senden.} other {# Änderungen auf diesem Gerät haben den Server noch nicht erreicht. Sie bleiben auf diesem Gerät, aber niemand sonst kann sie für Sie senden.}} Synchronisieren Sie vor dem Abmelden, wenn Sie eine Verbindung bekommen.',
    unsyncedConfirm: 'Trotzdem abmelden',
    unsyncedCancel: 'Angemeldet bleiben',
  },
  itemDetail: {
    accessPrivate: 'Privat',
    accessOrg: 'Organisation',
    accessPublic: 'Öffentlich',
    accessPrivateTitle: 'Nur Sie und Personen, mit denen Sie es teilen',
    accessOrgTitle: 'Alle, die an diesem Portal angemeldet sind',
    accessPublicTitle: 'Jeder im Internet, ohne Anmeldung',
    licenseTitle: 'Lizenz: {license}',
    statFeatures: 'Features',
    statGeometry: 'Geometrie',
    statCoordinates: 'Koordinaten',
    statFields: 'Felder',
    statLayers: 'Layer',
    statUpdated: 'Aktualisiert',
    statFeaturesTitle:
      'Live gezählt und auf das beschränkt, worauf Sie Zugriff haben; kann daher unter der veröffentlichten Gesamtzahl liegen.',
    statCoordinatesTitle:
      'Gespeichert als Breiten- und Längengrad (EPSG:4326). {source}',
    statCoordinatesFrom: 'Beim Import aus {srs} umgerechnet.',
    statCoordinatesNative: 'So sind die Daten angekommen.',
    statCoordinatesUnknown:
      'Die Quelldatei hat es nicht angegeben, daher wurde angenommen, dass es bereits Breiten- und Längengrad sind.',
    statUnavailable: 'Nicht verfügbar',
    statMixed: 'Gemischt',
    geometryPoint: 'Punkte',
    geometryLine: 'Linien',
    geometryPolygon: 'Flächen',
    geometryNone: 'Tabelle, keine Geometrien',
    previewTitle: 'Vorschau',
    previewEmpty: 'Noch nichts zu zeichnen',
    previewEmptyHint:
      'Dieser Layer hat keine Features mit Standort, daher gibt es auf einer Karte nichts zu zeigen.',
    previewFailed: 'Die Vorschau konnte nicht geladen werden',
    previewLoading: 'Vorschau wird geladen',
  },
  itemTabs: {
    overview: 'Übersicht',
    data: 'Daten',
    structure: 'Struktur',
    source: 'Quelle',
    metadata: 'Metadaten',
    access: 'Teilen',
    sections: 'Elementbereiche',
  },
  mapCard: {
    editTitle: 'Karte',
    editBody:
      'Öffnen Sie die Karte, um zu verschieben, zu zoomen und die Attributtabelle zu durchsuchen, sowie um Layer hinzuzufügen, die Grundkarte festzulegen und die Darstellung anzuordnen.',
    editAction: 'Karte öffnen',
    viewTitle: 'Karte',
    viewBody:
      'Öffnen Sie diese Karte, um zu verschieben, zu zoomen, Grundkarten zu wechseln und die Attributtabelle zu durchsuchen. Sie haben Lesezugriff, daher wird nichts gespeichert, was Sie hier ändern.',
    viewAction: 'Karte öffnen',
  },
  appCard: {
    editTitle: 'Benutzerdefinierte Web-App',
    editBody:
      'Öffnen Sie den Builder, um Widgets auf die Arbeitsfläche zu ziehen, Seiten anzuordnen und Datenlayer zu verknüpfen.',
    editAction: 'Builder öffnen',
    viewTitle: 'Web-App',
    viewBody: 'Öffnen Sie diese App und verwenden Sie sie so, wie ihre Leser sie sehen.',
    viewAction: 'App öffnen',
  },
  groupItems: {
    title: 'Mit dieser Gruppe geteilt',
    empty:
      'Mit dieser Gruppe ist noch nichts geteilt. Teilen Sie ein Element über seinen Tab „Teilen" mit der Gruppe, dann erscheint es hier.',
    openItem: 'Elementdetails öffnen',
    removeAction: 'Aus dieser Gruppe entfernen',
    removeTitle: 'Aus Gruppe entfernen',
    removeBody:
      '"{title}" aus dieser Gruppe entfernen? Gruppenmitglieder verlieren den Zugriff, den diese Freigabe gewährt hat; das Element selbst bleibt unberührt.',
    removeConfirm: 'Entfernen',
    removed: '"{title}" aus der Gruppe entfernt.',
    removeFailed: 'Element konnte nicht entfernt werden: HTTP {status}.',
  },
  housekeepingTabs: {
    review: 'Prüfen',
    cleanup: 'Aufräumen',
    starters: 'Startvorlagen',
    schedule: 'Zeitplan',
    sections: 'Wartungsbereiche',
  },
  v3Editor: {
    structureTitle: 'Layer-Struktur',
    structureIntro:
      'Bearbeiten Sie hier Layer, Felder, Domänen und Einschränkungen. Speichern wirkt sofort; Importieren und Durchsuchen von Zeilen finden Sie auf dem Tab Daten.',
    dataTitle: 'Layer-Daten',
    dataIntro:
      'Durchsuchen Sie die Zeilen jedes Layers, fügen Sie Daten hinzu oder laden Sie sie herunter.',
  },
  layerExport: {
    format: {
      csv: 'CSV',
      xlsx: 'Excel',
      geojson: 'GeoJSON',
      geoparquet: 'GeoParquet',
    },
    exported: '{count, plural, one {# Zeile} other {# Zeilen}} als {format} exportiert.',
    failed: '{format}-Export fehlgeschlagen',
    nothingLoaded: 'Nichts zu exportieren: für diesen Layer sind keine Zeilen geladen.',
    nothingSelected: 'Nichts zu exportieren: es sind keine Zeilen ausgewählt.',
    exportRows: '{count, plural, one {# Zeile} other {# Zeilen}} exportieren',
    noRows: 'Keine Zeilen zum Exportieren',
  },
  addToMap: {
    newMap: 'Neue Karte',
    existingMap: 'Eine vorhandene Karte',
    loadingMaps: 'Karten werden geladen...',
    noMaps: 'Noch keine Karten',
    layerGone: '{item} hat keinen Layer "{layerKey}" mehr.',
    tableNoShapes:
      '{layer} ist eine Tabelle ohne Geometrien, daher gibt es nichts zu zeichnen.',
  },
  mapSearch: {
    geocoderUnavailable:
      'Die Ortssuche ist gerade nicht verfügbar ({reason}). Die Layer-Ergebnisse oben sind davon nicht betroffen.',
    noPlaces:
      'Keine Orte dazu gefunden. Der Geocoder dieses Portals deckt nur das Gebiet ab, für das er eingerichtet wurde.',
  },
  adminFieldQueues: {
    rejectedByServer: '{count} vom Server abgelehnt',
    queuedSummary: '{queued} in der Warteschlange ({failed} fehlgeschlagen)',
    queuedSummaryWithRejected:
      '{queued} in der Warteschlange ({failed} fehlgeschlagen, {rejected} abgelehnt)',
    rejectedWaiting: 'abgelehnt, wartet auf den Worker',
    moreWithErrors: '+ {count} weitere Datensätze mit Fehlern.',
  },
  metadataPanel: {
    description: 'Beschreibung',
    noDescription:
      'Noch keine Beschreibung. Ein Satz dazu, was das ist und woher es stammt, macht den Unterschied zwischen einem Element, das jemand wiederverwendet, und einem, das jemand neu erstellt.',
    tags: 'Schlagwörter',
    noTags: 'Keine Schlagwörter.',
    type: 'Typ',
    owner: 'Besitzer',
    created: 'Erstellt',
    updated: 'Aktualisiert',
    license: 'Lizenz',
    source: 'Quelle',
    sourceFormat: 'Quellformat',
    originalProjection: 'Ursprüngliche Projektion',
    itemId: 'Element-ID',
    storageScope: 'Speicherbereich',
    storageScopeFor: 'Bereich: {layer}',
    storageTable: 'Speichertabelle',
    notRecorded: 'Nicht erfasst',
    copyTitle: '{label} kopieren',
    formatGeojson: 'GeoJSON',
    formatGeoparquet: 'GeoParquet',
    formatKml: 'KML',
    formatKmz: 'KMZ',
    formatShapefile: 'Shapefile',
    formatGdb: 'File Geodatabase',
    formatXlsx: 'Excel-Arbeitsmappe',
    formatCsv: 'CSV',
    formatManual: 'Von Hand eingegeben',
    formatApi: 'Über die API geladen',
  },
  copyButton: {
    copy: 'Kopieren',
    copied: 'Kopiert',
  },
  offlineAreas: {
    title: 'Offline-Gebiete',
    intro:
      'Das Portal bereitet pro Gebiet eine Kartendatei vor, sodass ein ganzer Landkreis ein einziger Download von wenigen Megabyte ist statt einer Million einzelner Anfragen.',
    addArea: 'Gebiet hinzufügen',
    loading: 'Gebiete werden geladen...',
    noneYet: 'Noch keine Gebiete.',
    noneYetNoExtent:
      'Fügen Sie der bereitgestellten Karte zuerst Daten hinzu, damit es eine Ausdehnung gibt, die vorbereitet werden kann.',
    noneYetHint:
      'Fügen Sie eines hinzu, damit Erfasser diese Bereitstellung offline mitnehmen können.',
    extentSummary: 'etwa {width} mal {height} Meilen',
    rebuildsEvery: 'wird alle {days} Tage neu erstellt',
    waiting: 'Wartet auf Start...',
    preparingCount: '{count} Kacheln werden vorbereitet...',
    preparing: 'Wird vorbereitet...',
    ready: 'Bereit',
    builtOn: 'erstellt {date}',
    buildFailed: 'Konnte nicht vorbereitet werden.',
    notPrepared: 'Noch nicht vorbereitet.',
    prepareAgain: 'Erneut vorbereiten',
    prepareNow: 'Jetzt vorbereiten',
    deleteArea: 'Gebiet löschen',
    deleteTitle: 'Dieses Gebiet löschen?',
    deleteBody:
      'Erfasser können "{name}" nicht mehr herunterladen. Was bereits auf einem Gerät ist, bleibt dort.',
    name: 'Name',
    namePlaceholder: 'Sommererhebung, Team Nord...',
    detailLabel: 'Detailgrad',
    detailHint:
      'Erfasser können immer weiter hineinzoomen als bis hierhin. Ab einem gewissen Punkt kommen auf der Karte nur keine neuen Beschriftungen mehr hinzu.',
    refreshLabel: 'Aktuell halten',
    refreshManual: 'Nur auf Anforderung',
    refreshWeekly: 'Wöchentlich',
    refreshMonthly: 'Monatlich',
    refreshQuarterly: 'Alle drei Monate',
    detailRoads: 'Straßen und Orte',
    detailRoadsHint: 'Kleinster Download',
    detailStreets: 'Ortsstraßen',
    detailPaths: 'Straßennamen und Wege',
    detailPathsHint: 'Empfohlen für Feldarbeit',
    detailBuildings: 'Gebäudeumrisse',
    detailBuildingsHint: 'Größter Download',
    tooBig:
      'Dieses Gebiet ist bei dieser Detailstufe zu groß. Wählen Sie weniger Detail oder teilen Sie die Bereitstellung in mehrere Gebiete auf.',
    sizeEstimate:
      'Deckt {extent} ab. Etwa {size} zum Herunterladen. Der genaue Wert wird gemessen, bevor etwas vorbereitet wird.',
    cancel: 'Abbrechen',
    addAndPrepare: 'Hinzufügen und vorbereiten',
    saveFailed: 'Gebiet konnte nicht gespeichert werden: {status}',
    buildStartFailed: 'Erstellung konnte nicht gestartet werden: {status}',
  },
  offlineBasemap: {
    preparedMap: 'Vorbereitete Karte',
    preparedMaps: 'Vorbereitete Karten',
    onThisDevice: 'Auf diesem Gerät',
    includedWithSize: '{size}, im Download oben enthalten',
    included: 'Im Download oben enthalten',
    removeFromDevice: 'Von diesem Gerät entfernen',
    removeAria: '{name} von diesem Gerät entfernen',
    explainer:
      'Ihre Teamleitung hat diese Karten vorbereitet, daher kommen sie als einzelne Dateien statt Stück für Stück, und sie werden ganz ohne Empfang gezeichnet.',
    unsupported:
      'Dieser Browser kann Karten nicht offline speichern. Versuchen Sie, die App zum Startbildschirm hinzuzufügen.',
    preparedNoticeOne:
      'Die Karte für diese Bereitstellung ist bereits vorbereitet und kommt daher als eine Datei.',
    preparedNoticeMany:
      'Die Karten für diese Bereitstellung sind bereits vorbereitet und kommen daher als einzelne Dateien.',
    downloadStopped:
      'Download angehalten. Was bereits gespeichert ist, bleibt auf diesem Gerät.',
  },
  itemMenu: {
    actions: 'Elementaktionen',
    open: 'Öffnen',
    responses: 'Antworten',
    configure: 'Konfigurieren',
    previewData: 'Datenvorschau',
    addToMap: 'Zur Karte hinzufügen',
    addLayerToMapTitle: 'Nur diese Ebene zu einer Karte hinzufügen',
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
    openMap: 'Neue Karte',
    addItems: 'Elemente hinzufügen',
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
      'Fügen Sie vorhandene Elemente hinzu, erstellen Sie etwas Neues oder ziehen Sie Elemente aus der Ansicht aller Elemente hierher.',
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
  adminBackup: {
    startFailed: 'Die Sicherung konnte nicht gestartet werden.',
    deleteFailed: 'Die Sicherung konnte nicht gelöscht werden.',
    stopFailed: 'Die Sicherung konnte nicht angehalten werden.',
    stop: 'Anhalten',
    stopping: 'Wird angehalten...',
    stopTitle:
      'Diese Sicherung zum Anhalten auffordern. Erst wenn eine Sicherung abgeschlossen ist, wird etwas veröffentlicht; Anhalten ist daher immer sicher.',
    fileMissing: 'Datei nicht mehr auf dem Server',
    fileMissingTitle:
      'Diese Sicherung wurde abgeschlossen, aber ihre Datei liegt nicht mehr im Sicherungsordner. Sie wurde möglicherweise verschoben, von Hand gelöscht oder gehört zu einer früheren Wiederherstellung der Datenbank. Sie kann weder heruntergeladen noch wiederhergestellt werden.',
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
