// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 1.1 Spanish catalog.
 *
 * Machine-translated seed (initial pass 2026-06-01). Native
 * speakers: please review and refine. Open a pull request with
 * fixes; the locale picker tags this locale "MT" until a native
 * speaker has signed off. See CONTRIBUTING-TRANSLATIONS.md.
 *
 * Conventions: neutral pan-Hispanic Spanish (avoids strongly
 * regional variants). Formality: tuteo by default to match the
 * casual tone of the source English ("Sign in," not "Please sign
 * in"). For Spain-specific or LATAM-specific refinements, open a
 * separate locale (e.g. `es-ES`, `es-MX`) rather than diverging
 * this catalog.
 */
import type { CatalogShape } from '../locales';

export const es: Partial<CatalogShape> = {
  common: {
    save: 'Guardar',
    cancel: 'Cancelar',
    delete: 'Eliminar',
    close: 'Cerrar',
    edit: 'Editar',
    loading: 'Cargando…',
    backToItems: 'Volver a los elementos',
    settings: 'Configuración',
    language: 'Idioma',
  },
  nav: {
    items: 'Elementos',
    home: 'Inicio',
    admin: 'Administración',
    profile: 'Perfil',
    signOut: 'Cerrar sesión',
    signIn: 'Iniciar sesión',
    overview: 'Resumen',
    folders: 'Carpetas',
    groups: 'Grupos',
    recentlyDeleted: 'Eliminados recientemente',
    users: 'Usuarios',
    landingPage: 'Página de inicio',
    backup: 'Copia de seguridad',
    housekeeping: 'Mantenimiento',
    notifications: 'Notificaciones',
    fieldQueues: 'Colas de campo',
    migrations: 'Migraciones',
    gettingStarted: 'Primeros pasos',
  },
  shell: {
    notificationsLabel: 'Notificaciones',
    navigation: 'Navegación',
    openNavigation: 'Abrir navegación',
    closeNavigation: 'Cerrar navegación',
  },
  search: {
    placeholder: 'Buscar elementos...',
    label: 'Buscar elementos',
  },
  help: {
    buttonTitle: 'Ayuda (pulsa ? en cualquier momento)',
    openLabel: 'Abrir ayuda',
  },
  newItem: {
    pageTitle: 'Crear un nuevo elemento',
    pageIntro:
      'Elige lo que vas a crear y luego completa los detalles. Para servicios y archivos subidos, recopilaremos lo necesario en la siguiente pantalla para que el elemento quede listo para usar.',
    createButton: 'Crear elemento',
    backButton: 'Atrás',
    viewerBlocked:
      'Tu cuenta tiene el rol Visor, que puede abrir y descargar elementos pero no crearlos. Un administrador de la organización puede cambiar tu rol u otorgarte solo la capacidad de publicar.',
  },
  newItemJob: {
    data_layer:
      'Empieza aquí si tienes una hoja de cálculo, un shapefile o un archivo GeoJSON que subir.',
    map: 'Empieza aquí para poner en un mapa datos que ya has subido y compartirlo.',
    form: 'Empieza aquí si quieres que la gente rellene respuestas, una a una, desde un enlace que les envíes.',
    data_collection:
      'Empieza aquí si quieres que un equipo registre en un mapa lo que encuentra desde sus teléfonos, sin conexión.',
  },
  metadataXml: {
    intro:
      'Rellena previamente el título, la descripción y las etiquetas a partir de un archivo de {term}, del tipo que ArcGIS, QGIS o un catálogo de datos público exporta junto con un conjunto de datos. Reconoce ISO 19115, FGDC CSDGM y Dublin Core.',
    term: 'XML de metadatos',
    importTitle:
      'Importa un archivo XML de metadatos exportado por ArcGIS, QGIS o un catálogo de datos (ISO 19115, FGDC CSDGM o Dublin Core) para rellenar previamente los campos de abajo',
  },
  layerBuilder: {
    tableName: 'Nombre de la tabla',
    tableNameTitle:
      'El nombre que tiene esta capa en la base de datos y en las direcciones web. En minúsculas, con guiones bajos en lugar de espacios.',
    dropToImport: 'Suelta para importar.',
    dropHint: 'Suelta un archivo aquí o haz clic para elegir uno.',
    importUsual:
      'Lo habitual es una hoja de cálculo guardada como CSV, con una columna de latitud y otra de longitud.',
    importAlso:
      'También: TSV · GeoJSON · GeoParquet (.parquet) · KML / KMZ (Google Earth) · GeoPackage (.gpkg, solo tablas vectoriales) · Shapefile (.zip) · File Geodatabase (.gdb.zip)',
  },
  mapEditor: {
    legendButton: 'Leyenda',
    tableButton: 'Tabla de atributos',
    markupButton: 'Anotaciones',
    commentsButton: 'Comentarios',
    printButton: 'Imprimir este mapa',
    layerAccessButton: 'Acceso a las capas',
    saveMapButton: 'Guardar mapa',
    savedIndicator: 'Guardado',
  },
  featureEdit: {
    groupLabel: 'Editar',
    editShape: 'Editar forma',
    addFeature: 'Añadir entidad',
    deleteFeature: 'Eliminar entidad',
    layerToAddTo: 'Capa a la que añadir',
    snappingOn: 'Ajuste activado',
    snappingOff: 'Ajuste desactivado',
    hintEdit:
      'Haz clic en una entidad de una capa editable para mover sus vértices.',
    hintLoading: 'Cargando la entidad...',
    hintDelete: 'Haz clic en una entidad de una capa editable para eliminarla.',
    hintAddPoint: 'Haz clic en el mapa para colocar la entidad.',
    hintAddPath:
      'Haz clic para añadir vértices; haz doble clic o haz clic en el primer vértice para terminar.',
    editingIn:
      'Editando una entidad en {layer}. Arrastra los vértices; haz clic en un punto medio para añadir uno.',
    cancel: 'Cancelar',
    saveShape: 'Guardar forma',
    shapeSaved: 'Forma guardada.',
    featureAdded: 'Entidad añadida.',
    featureDeleted: 'Entidad eliminada.',
    newFeatureTitle: 'Nueva entidad',
    newFeatureAttributes: 'Atributos de la nueva entidad',
    addAction: 'Añadir entidad',
    deleteConfirmTitle: '¿Eliminar esta entidad?',
    deleteConfirmMessage:
      'Se quitará de "{layer}". Esto no se puede deshacer desde aquí.',
    deleteAction: 'Eliminar',
    noStableId:
      'Esta entidad no tiene un id estable y no se puede editar aquí.',
    noGeometry: 'Esta capa no tiene geometría que editar.',
    notFound: 'No se encontró esa entidad en el servidor.',
    loadFailed: 'No se pudo cargar la entidad',
    saveFailed: 'Error al guardar',
    deleteFailed: 'Error al eliminar',
    addFailed: 'No se pudo añadir la entidad',
    unnamedLayer: 'capa',
  },
  presence: {
    youSuffix: ' (tú)',
  },
  comments: {
    title: 'Comentarios',
    showResolved: 'Mostrar resueltos',
    startThread: 'Iniciar un nuevo hilo...',
    post: 'Publicar',
    reply: 'Responder...',
    resolve: 'Resolver',
    reopen: 'Reabrir',
    threadCount: '{count, plural, one {# hilo} other {# hilos}}',
    noOpen:
      'No hay hilos abiertos. Activa "Mostrar resueltos" para ver los cerrados.',
    noComments:
      'Aún no hay comentarios. Inicia la conversación a continuación.',
    signInPrompt: 'Inicia sesión para comentar en este mapa.',
  },
  markup: {
    title: 'Anotaciones',
    add: 'Añadir anotación',
    empty:
      'Aún no hay anotaciones. Añade un conjunto y luego coloca chinchetas para anotar el mapa.',
    dropPin: 'Colocar chincheta en el centro',
    signInPrompt: 'Inicia sesión para añadir anotaciones a este mapa.',
  },
  print: {
    chooserTitle: 'Imprimir este mapa',
    startSection: 'Crear un nuevo diseño',
    startAction:
      'Crear un nuevo diseño de impresión vinculado a este mapa',
    startHint:
      'Abre el diseñador de impresión con este mapa ya conectado a los elementos de Mapa, Leyenda, Escala y Flecha de norte.',
    pickSection: 'Usar un diseño existente',
    pickEmpty:
      'Aún no hay diseños de impresión disponibles. Usa "Crear un nuevo diseño de impresión" arriba para crear uno.',
  },
  errors: {
    generic: 'Algo salió mal',
    unauthorized: 'Inicia sesión para continuar',
    notFound: 'No encontrado',
    sessionExpired:
      'Tu sesión ha caducado. Inicia sesión de nuevo para ver todo aquello a lo que tienes acceso.',
  },
  errorReason: {
    unknown: 'error desconocido',
  },
  addToFolder: {
    heading: 'Añadir {count, plural, one {# elemento} other {# elementos}} a una carpeta',
    searchPlaceholder: 'Buscar carpetas',
    noMatches: 'Ninguna carpeta coincide.',
    itemCount: '{count, plural, one {# elemento} other {# elementos}}',
  },
  areaSearch: {
    title: 'Buscar por área',
    hint: 'Desplaza y haz zoom; la lista se actualiza automáticamente.',
    close: 'Cerrar búsqueda por área',
    myLocation: 'Mi ubicación',
    myLocationTitle: 'Centrar el mapa en tu ubicación actual',
    padAreaBy: 'Ampliar el área en',
    searching: 'Buscando...',
    refreshNow: 'Actualizar ahora',
  },
  dataPreview: {
    title: 'Vista previa de datos',
    eyebrow: 'Vista previa',
    openItem: 'Abrir elemento',
    closePreview: 'Cerrar vista previa',
    layer: 'Capa',
    layerLabel: 'Capa:',
    table: 'tabla',
    tableSuffix: '(tabla)',
    noFeatures: 'No hay entidades en esta capa.',
    featureCount: '{count, plural, one {# entidad} other {# entidades}}',
    featureCountOverflow: '{count}+ de muchas entidades',
    fieldCount: '{count, plural, one {# campo} other {# campos}}',
    overflowNotice:
      'Mostrando las primeras {limit} entidades. Abre el editor de mapas del elemento para ver la tabla de atributos completa.',
    upstreamError: 'El origen devolvió un error',
    loadFailed:
      'No se pudo cargar la vista previa. Abre el elemento para ver los detalles.',
  },
  filter: {
    filter: 'Filtrar',
    filterItems: 'Filtrar elementos',
    activeCount:
      '{count, plural, one {# filtro activo} other {# filtros activos}}',
    type: 'Tipo',
    clearTypes: 'Borrar tipos',
    noItemsToFilter: 'No hay elementos que filtrar en la vista actual.',
    template: 'Plantilla',
    owner: 'Propietario',
    access: 'Acceso',
    area: 'Área',
    clearArea: 'Borrar área',
    filterByArea: 'Filtrar por área...',
    filteringByArea: 'Filtrando por área',
    clearAll: 'Borrar todos los filtros',
  },
  folders: {
    hide: 'Ocultar carpetas',
  },
  folderRail: {
    newButton: '+ Nueva',
    collapse: 'Contraer carpeta',
    expand: 'Expandir carpeta',
    folderNamePlaceholder: 'Nombre de la carpeta',
    emptyPrefix: 'Aún no hay carpetas.',
    createOne: 'Crea una',
    emptySuffix: 'para organizar tus elementos.',
    moveFailedTitle: 'Error al mover',
    moveFailedMessage: 'No se pudo mover el elemento.',
  },
  folderMenu: {
    actionsFor: 'Acciones para {folder}',
    moreActions: 'Más acciones',
    share: 'Compartir...',
    newSubfolder: 'Nueva subcarpeta',
    trashTitle: '¿Mover la carpeta a la papelera?',
    trashMessage:
      '¿Mover "{folder}" a la papelera? El contenido de la carpeta se queda donde está; solo se elimina la organización en carpetas.',
    trashMessageCascade:
      '¿Mover "{folder}" y las subcarpetas indicadas a la papelera? Los elementos que no son carpetas se quedan donde están; solo se elimina la organización en carpetas.',
    subfoldersAlsoTrashed:
      '{count, plural, one {# subcarpeta también se moverá a la papelera:} other {# subcarpetas también se moverán a la papelera:}}',
    andMore: '...y {count} más.',
    unlinkedItems:
      '{count, plural, one {# otro elemento dentro perderá su referencia a la carpeta, pero el elemento se conserva.} other {# otros elementos dentro perderán su referencia a la carpeta, pero los elementos se conservan.}}',
    multiParentNote:
      'Las subcarpetas que también están archivadas en otra carpeta sobrevivirán a esta eliminación y no se muestran.',
    trashing: 'Moviendo...',
    trashFailedTitle: 'No se pudo mover a la papelera',
    trashFailedMessage: 'Error al mover a la papelera: {status}',
  },
  field: {
    nav: 'Campo',
    qrAlt: 'Código QR con enlace a este despliegue',
    qrHint:
      'Apunta la cámara de un teléfono aquí para abrir el despliegue en ese dispositivo.',
    qrSignIn: 'La primera vez se te pedirá iniciar sesión en el teléfono.',
    copyLink: 'Copiar enlace',
    copied: 'Copiado',
    openOnPhone: 'Abrir en un teléfono',
  },
  fieldQueue: {
    rejectedChip:
      '{count, plural, one {# edición necesita atención} other {# ediciones necesitan atención}}',
    rejectedChipTitle:
      'El servidor rechazó estas ediciones. Abre para ver por qué y reintentarlas o descartarlas.',
    rejectedTitle: 'Ediciones que el servidor rechazó',
    rejectedIntro:
      'Estas ediciones se enviaron pero no se aceptaron, y enviarlas de nuevo sin cambios daría la misma respuesta. Corrige lo que indica el mensaje y reintenta, o descarta la edición.',
    rejectedEmpty: 'No hay nada aquí. Todas las ediciones se han aceptado.',
    op: {
      insert: 'Nueva entidad en {layer}',
      update: 'Cambio en una entidad de {layer}',
      delete: 'Eliminación en {layer}',
    },
    unknownLayer: 'una capa que ya no está en este despliegue',
    noReason: 'El servidor no dijo por qué.',
    retry: 'Reintentar',
    retryAll: 'Reintentar las {count}',
    discard: 'Descartar',
    discardTitle: '¿Descartar esta edición?',
    discardMessage:
      'Solo existe en este dispositivo. Una vez descartada no se puede recuperar.',
    discardAction: 'Descartar edición',
    close: 'Cerrar',
  },
  fieldAttachments: {
    heading: 'Fotos y archivos',
    headingCount: 'Fotos y archivos · {count}',
    add: 'Añadir foto',
    emptyCanCapture:
      'Aún no hay fotos. Se guardan en este dispositivo y se suben con el registro.',
    emptyReadOnly: 'No hay fotos en este registro.',
    pendingBadge: 'En el dispositivo',
    pendingBadgeTitle: 'Esperando para subir',
    discardLabel: 'Descartar {name}',
    discardTitle: '¿Descartar este archivo?',
    discardMessage:
      '{name} aún no se ha subido. Al descartarlo se elimina de este dispositivo y no se puede recuperar.',
    discardAction: 'Descartar',
    quotaError:
      'No queda espacio en este dispositivo para otra foto. Sincroniza o libera espacio primero.',
    saveError: 'No se pudo guardar el archivo: {reason}',
  },
  fieldCollect: {
    cancel: 'Cancelar',
    submit: 'Enviar',
    addTitle: 'Nueva entidad: {layer}',
    editTitle: 'Editar entidad: {layer}',
    addAria: 'Añadir {layer}',
    editAria: 'Editar {layer}',
    discardTitle: '¿Descartar este registro?',
    discardMessage:
      'Has introducido información que no se ha guardado. Descartarla no se puede deshacer.',
    discardAction: 'Descartar',
    discardCancel: 'Seguir editando',
  },
  fieldRuntime: {
    pickTypeSheet: 'Elige un tipo de entidad para añadir',
    featureDetailsSheet: 'Detalles de la entidad',
    queueReadFailed: 'No se pudo leer la cola sin conexión.',
  },
  fieldGps: {
    accuracy: 'Precisión GPS {meters} m',
    denied:
      'La ubicación está bloqueada. Permítela en la configuración del navegador para capturar en tu posición.',
    unavailable:
      'La ubicación no está disponible en este dispositivo. Las entidades se colocarán en el centro del mapa.',
  },
  fieldOffline: {
    partial: 'Incompleto. No se descargó: {missing}.',
    partialOutOfSpace:
      'Incompleto: se agotó el almacenamiento. No se descargó: {missing}.',
    partialMissingMore: '{missing} y {count} más',
    quotaTitle: 'No hay suficiente almacenamiento para esta descarga',
    quotaBody:
      'Esta descarga necesita unos {needed} y faltan ~{short}. Libera despliegues en caché o almacenamiento del dispositivo, o reduce el nivel de detalle, e inténtalo de nuevo.',
    identityTitle: 'Trabajo sin sincronizar de otra cuenta',
    identityBody:
      'Este dispositivo contiene {records, plural, =0 {ningún registro} one {# registro sin sincronizar} other {# registros sin sincronizar}} y {files, plural, =0 {ninguna foto} one {# foto} other {# fotos}} capturados por otra cuenta. No han llegado al servidor.',
    identityKeepExplain:
      'Si los conservas aquí, se quedan aparcados en este dispositivo, ocultos de tus recuentos de sincronización, y se envían cuando esa cuenta vuelva a iniciar sesión.',
    identityRemoveExplain:
      'Si los quitas, se eliminan de este dispositivo. Nada más guarda una copia.',
    identityKeep: 'Conservarlos aquí',
    identityRemove: 'Quitarlos de este dispositivo',
    identityRemoved:
      'Quitados de este dispositivo: {records, plural, one {# registro} other {# registros}} y {files, plural, one {# foto} other {# fotos}}.',
    identityRemoveFailed: 'No se pudieron quitar los datos de la otra cuenta.',
    removeWillLose:
      '{count, plural, one {Se perderá # edición sin sincronizar.} other {Se perderán # ediciones sin sincronizar.}}',
    removeWillLoseOthers:
      '{count, plural, one {# de ellas pertenece a otra cuenta.} other {# de ellas pertenecen a otra cuenta.}}',
  },
  signOut: {
    unsyncedTitle: '¿Cerrar sesión con trabajo sin sincronizar?',
    unsyncedMessage:
      '{count, plural, one {# edición en este dispositivo aún no ha llegado al servidor. Se quedará en este dispositivo, pero nadie más puede enviarla por ti.} other {# ediciones en este dispositivo aún no han llegado al servidor. Se quedarán en este dispositivo, pero nadie más puede enviarlas por ti.}} Sincroniza antes de cerrar sesión si consigues conexión.',
    unsyncedConfirm: 'Cerrar sesión de todos modos',
    unsyncedCancel: 'Seguir con la sesión iniciada',
  },
  itemDetail: {
    accessPrivate: 'Privado',
    accessOrg: 'Organización',
    accessPublic: 'Público',
    accessPrivateTitle: 'Solo tú y las personas con quienes lo compartas',
    accessOrgTitle: 'Cualquiera que haya iniciado sesión en este portal',
    accessPublicTitle: 'Cualquiera en internet, sin necesidad de iniciar sesión',
    licenseTitle: 'Licencia: {license}',
    statFeatures: 'Entidades',
    statGeometry: 'Forma',
    statCoordinates: 'Coordenadas',
    statFields: 'Campos',
    statLayers: 'Capas',
    statUpdated: 'Actualizado',
    statFeaturesTitle:
      'Contadas en vivo y limitadas a lo que tienes acceso, así que puede ser menor que el total publicado.',
    statCoordinatesTitle:
      'Almacenadas como latitud y longitud (EPSG:4326). {source}',
    statCoordinatesFrom: 'Convertidas desde {srs} al importarlas.',
    statCoordinatesNative: 'Así es como llegaron.',
    statCoordinatesUnknown:
      'El archivo de origen no lo indicaba, así que se asumió que ya eran latitud y longitud.',
    statUnavailable: 'No disponible',
    statMixed: 'Mixto',
    geometryPoint: 'Puntos',
    geometryLine: 'Líneas',
    geometryPolygon: 'Áreas',
    geometryNone: 'Tabla, sin formas',
    previewTitle: 'Vista previa',
    previewEmpty: 'Aún no hay nada que dibujar',
    previewEmptyHint:
      'Esta capa no tiene entidades con ubicación, así que no hay nada que mostrar en un mapa.',
    previewFailed: 'No se pudo cargar la vista previa',
    previewLoading: 'Cargando la vista previa',
  },
  itemTabs: {
    overview: 'Resumen',
    data: 'Datos',
    structure: 'Estructura',
    source: 'Origen',
    metadata: 'Metadatos',
    access: 'Compartir',
    sections: 'Secciones del elemento',
  },
  mapCard: {
    editTitle: 'Mapa',
    editBody:
      'Abre el mapa para desplazarte, hacer zoom y explorar la tabla de atributos, y para añadir capas, definir el mapa base y organizar el lienzo.',
    editAction: 'Abrir mapa',
    viewTitle: 'Mapa',
    viewBody:
      'Abre este mapa para desplazarte, hacer zoom, cambiar de mapa base y explorar la tabla de atributos. Tienes acceso de visualización, así que nada de lo que cambies aquí se guarda.',
    viewAction: 'Abrir mapa',
  },
  appCard: {
    editTitle: 'Aplicación web personalizada',
    editBody:
      'Abre el constructor para arrastrar widgets al lienzo, organizar páginas y vincular capas de datos.',
    editAction: 'Abrir constructor',
    viewTitle: 'Aplicación web',
    viewBody: 'Abre esta aplicación y úsala tal como la ven sus lectores.',
    viewAction: 'Abrir aplicación',
  },
  groupItems: {
    title: 'Compartido con este grupo',
    empty:
      'Aún no se ha compartido nada con este grupo. Comparte un elemento con el grupo desde su pestaña Compartir y aparecerá aquí.',
    openItem: 'Abrir detalles del elemento',
    removeAction: 'Quitar de este grupo',
    removeTitle: 'Quitar del grupo',
    removeBody:
      '¿Quitar "{title}" de este grupo? Los miembros del grupo pierden el acceso que este permiso concedía; el elemento en sí no se toca.',
    removeConfirm: 'Quitar',
    removed: 'Se quitó "{title}" del grupo.',
    removeFailed: 'No se pudo quitar el elemento: HTTP {status}.',
  },
  housekeepingTabs: {
    review: 'Revisar',
    cleanup: 'Limpieza',
    starters: 'Plantillas iniciales',
    schedule: 'Programación',
    sections: 'Secciones de mantenimiento',
  },
  v3Editor: {
    structureTitle: 'Estructura de la capa',
    structureIntro:
      'Edita aquí capas, campos, dominios y restricciones. Guardar tiene efecto inmediato; importar y explorar filas está en la pestaña Datos.',
    dataTitle: 'Datos de la capa',
    dataIntro: 'Explora las filas de cada capa, añade más datos o descárgalos.',
  },
  layerExport: {
    format: {
      csv: 'CSV',
      xlsx: 'Excel',
      geojson: 'GeoJSON',
      geoparquet: 'GeoParquet',
    },
    exported:
      '{count, plural, one {# fila exportada} other {# filas exportadas}} como {format}.',
    failed: 'La exportación a {format} falló',
    nothingLoaded: 'Nada que exportar: esta capa no tiene filas cargadas.',
    nothingSelected: 'Nada que exportar: no hay filas seleccionadas.',
    exportRows: 'Exportar {count, plural, one {# fila} other {# filas}}',
    noRows: 'No hay filas que exportar',
  },
  addToMap: {
    newMap: 'Nuevo mapa',
    existingMap: 'Un mapa existente',
    loadingMaps: 'Cargando mapas...',
    noMaps: 'Aún no hay mapas',
    layerGone: '{item} ya no tiene una capa "{layerKey}".',
    tableNoShapes:
      '{layer} es una tabla sin formas, así que no hay nada que dibujar.',
  },
  mapSearch: {
    geocoderUnavailable:
      'La búsqueda de lugares no está disponible ahora mismo ({reason}). Los resultados de capas de arriba no se ven afectados.',
    noPlaces:
      'No se encontraron lugares con eso. El geocodificador de este portal solo cubre el área con la que se configuró.',
  },
  adminFieldQueues: {
    rejectedByServer: '{count} rechazados por el servidor',
    queuedSummary: '{queued} en cola ({failed} con error)',
    queuedSummaryWithRejected:
      '{queued} en cola ({failed} con error, {rejected} rechazados)',
    rejectedWaiting: 'rechazado, esperando al worker',
    moreWithErrors: '+ {count} registros más con errores.',
  },
  metadataPanel: {
    description: 'Descripción',
    noDescription:
      'Aún no hay descripción. Una frase sobre qué es esto y de dónde viene es la diferencia entre un elemento que alguien reutiliza y uno que vuelve a crear.',
    tags: 'Etiquetas',
    noTags: 'Sin etiquetas.',
    type: 'Tipo',
    owner: 'Propietario',
    created: 'Creado',
    updated: 'Actualizado',
    license: 'Licencia',
    source: 'Origen',
    sourceFormat: 'Formato de origen',
    originalProjection: 'Proyección original',
    itemId: 'ID del elemento',
    storageScope: 'Ámbito de almacenamiento',
    storageScopeFor: 'Ámbito: {layer}',
    storageTable: 'Tabla de almacenamiento',
    notRecorded: 'No registrado',
    copyTitle: 'Copiar {label}',
    formatGeojson: 'GeoJSON',
    formatGeoparquet: 'GeoParquet',
    formatKml: 'KML',
    formatKmz: 'KMZ',
    formatShapefile: 'Shapefile',
    formatGdb: 'Geodatabase de archivos',
    formatXlsx: 'Libro de Excel',
    formatCsv: 'CSV',
    formatManual: 'Introducido a mano',
    formatApi: 'Cargado a través de la API',
  },
  copyButton: {
    copy: 'Copiar',
    copied: 'Copiado',
  },
  offlineAreas: {
    title: 'Áreas sin conexión',
    intro:
      'El portal prepara un archivo de mapa por área, así que un condado entero es una sola descarga de unos pocos megabytes en lugar de un millón de solicitudes separadas.',
    addArea: 'Añadir área',
    loading: 'Cargando áreas...',
    noneYet: 'Aún no hay áreas.',
    noneYetNoExtent:
      'Añade primero algunos datos al mapa desplegado, para que haya una extensión que preparar.',
    noneYetHint:
      'Añade una y los recolectores podrán llevarse este despliegue sin conexión.',
    extentSummary: 'unas {width} por {height} millas',
    rebuildsEvery: 'se reconstruye cada {days} días',
    waiting: 'Esperando para empezar...',
    preparingCount: 'Preparando {count} teselas...',
    preparing: 'Preparando...',
    ready: 'Listo',
    builtOn: 'creado {date}',
    buildFailed: 'No se pudo preparar.',
    notPrepared: 'Aún no preparado.',
    prepareAgain: 'Preparar de nuevo',
    prepareNow: 'Preparar ahora',
    deleteArea: 'Eliminar área',
    deleteTitle: '¿Eliminar esta área?',
    deleteBody:
      'Los recolectores ya no podrán descargar "{name}". Lo que ya esté en un dispositivo se queda allí.',
    name: 'Nombre',
    namePlaceholder: 'Campaña de verano, equipo norte...',
    detailLabel: 'Cuánto detalle',
    detailHint:
      'Los recolectores siempre pueden acercarse más que esto. Pasado cierto punto, el mapa simplemente deja de añadir etiquetas nuevas.',
    refreshLabel: 'Mantener actualizado',
    refreshManual: 'Solo cuando lo pida',
    refreshWeekly: 'Semanalmente',
    refreshMonthly: 'Mensualmente',
    refreshQuarterly: 'Cada tres meses',
    detailRoads: 'Carreteras y poblaciones',
    detailRoadsHint: 'Descarga más pequeña',
    detailStreets: 'Calles locales',
    detailPaths: 'Nombres de calles y caminos',
    detailPathsHint: 'Recomendado para trabajo de campo',
    detailBuildings: 'Contornos de edificios',
    detailBuildingsHint: 'Descarga más grande',
    tooBig:
      'Esta área es demasiado grande con ese nivel de detalle. Elige menos detalle o divide el despliegue en más de un área.',
    sizeEstimate:
      'Cubre {extent}. Aproximadamente {size} de descarga. La cifra exacta se mide antes de preparar nada.',
    cancel: 'Cancelar',
    addAndPrepare: 'Añadir y preparar',
    saveFailed: 'No se pudo guardar el área: {status}',
    buildStartFailed: 'No se pudo iniciar la preparación: {status}',
  },
  offlineBasemap: {
    preparedMap: 'Mapa preparado',
    preparedMaps: 'Mapas preparados',
    onThisDevice: 'En este dispositivo',
    includedWithSize: '{size}, incluido en la descarga de arriba',
    included: 'Incluido en la descarga de arriba',
    removeFromDevice: 'Quitar de este dispositivo',
    removeAria: 'Quitar {name} de este dispositivo',
    explainer:
      'El responsable de tu equipo preparó estos mapas, así que se descargan como archivos únicos en lugar de pieza a pieza, y se dibujan sin ninguna señal.',
    unsupported:
      'Este navegador no puede almacenar mapas sin conexión. Prueba a añadir la aplicación a tu pantalla de inicio.',
    preparedNoticeOne:
      'El mapa de este despliegue ya está preparado, así que se descarga como un solo archivo.',
    preparedNoticeMany:
      'Los mapas de este despliegue ya están preparados, así que se descargan como archivos únicos.',
    downloadStopped:
      'Descarga detenida. Lo que ya se guardó sigue en este dispositivo.',
  },
  itemMenu: {
    actions: 'Acciones del elemento',
    open: 'Abrir',
    responses: 'Respuestas',
    configure: 'Configurar',
    previewData: 'Vista previa de datos',
    addToMap: 'Añadir al mapa',
    addLayerToMapTitle: 'Añadir solo esta capa a un mapa',
    moveToFolder: 'Mover a carpeta',
    removeFromFolder: 'Quitar de esta carpeta',
    removeFromNamedFolder: 'Quitar de "{folder}"',
  },
  itemForm: {
    itemType: 'Tipo de elemento',
    title: 'Título',
    titlePlaceholder: 'Mi capa, informe, formulario...',
    titleRequired: 'El título es obligatorio.',
    description: 'Descripción',
    descriptionPlaceholder: '¿Qué es esto y para quién es?',
    tags: 'Etiquetas',
    tagsPlaceholder: 'Separadas por comas, p. ej. edificios, parcelas, campus',
    tagsHint: 'Se usa para buscar y filtrar.',
    thumbnail: 'Miniatura',
    visibility: 'Visibilidad',
    visibilityHintCreate:
      'Puedes cambiarlo más tarde y añadir permisos explícitos desde la página de detalles del elemento.',
    visibilityHintEdit:
      'Ajusta con permisos por usuario o por grupo desde la página de detalles.',
    license: 'Licencia',
    licenseHintPrefix:
      'Cómo se permite reutilizar este elemento. Se muestra en el catálogo de datos abiertos de la organización',
    licenseHintSuffix: 'para elementos públicos.',
    licenseCustomPlaceholder:
      'Id SPDX o URL de la licencia (p. ej. https://creativecommons.org/licenses/by/4.0/)',
    recipe: 'Receta',
    pickSourceLayer:
      'Elige una capa de datos de origen para esta capa derivada.',
    addPipelineStep:
      'Añade al menos un paso de herramienta a la canalización.',
    saveFailed: '{method} falló: {status} {detail}',
    saveChanges: 'Guardar cambios',
    type: {
      map: {
        label: 'Mapa',
        desc: 'Un mapa base + capas superpuestas con estilos.',
      },
      data_layer: {
        label: 'Capa de datos',
        desc: 'Una capa vectorial compartible respaldada por PostGIS.',
      },
      arcgis_service: {
        label: 'Servicio ArcGIS',
        desc: 'Puntero en vivo a un MapServer o FeatureServer de ArcGIS.',
      },
      form: {
        label: 'Formulario',
        desc: 'Un formulario de recogida para trabajo de campo o encuestas.',
      },
      web_app: {
        label: 'Aplicación web',
        desc: 'Una aplicación configurable construida con widgets.',
      },
      report_template: {
        label: 'Plantilla de informe',
        desc: 'Una plantilla de documento que representa datos.',
      },
      dashboard: {
        label: 'Panel',
        desc: 'Paneles en vivo que muestran datos de entidades.',
      },
      file: {
        label: 'Archivo',
        desc: 'Cualquier archivo subido (PDF, imagen, zip, etc.).',
      },
    },
    access: {
      private: {
        label: 'Privado',
        desc: 'Solo tú y las personas con quienes lo compartas.',
      },
      org: {
        label: 'Tu organización',
        desc: 'Cualquiera con una cuenta en tu organización.',
      },
      public: { label: 'Público', desc: 'Cualquiera en internet.' },
    },
    licenseOption: {
      notSpecified: {
        label: 'No especificada',
        hint: 'Se trata como "derechos reservados"',
      },
      cc0: { label: 'CC0 (dominio público)', hint: 'Sin derechos reservados' },
      ccBy: { label: 'CC BY 4.0', hint: 'Reutilización con atribución' },
      ccBySa: { label: 'CC BY-SA 4.0', hint: 'Atribución + compartir igual' },
      ccByNc: { label: 'CC BY-NC 4.0', hint: 'Atribución, no comercial' },
      oglUk: {
        label: 'Licencia de Gobierno Abierto del Reino Unido v3',
        hint: '',
      },
      odbl: { label: 'Open Database License 1.0', hint: '' },
      mit: {
        label: 'MIT',
        hint: 'Permisiva; común también para conjuntos de datos',
      },
      proprietary: {
        label: 'Propietaria / derechos reservados',
        hint: 'Solo para uso interno',
      },
      custom: { label: 'Personalizada…', hint: 'Especifica tu propio valor' },
    },
  },
  items: {
    share: 'Compartir',
    adding: 'Añadiendo...',
    addToFolder: 'Añadir a carpeta',
    addToNamedFolder: 'Añadir a {folder}',
    addToFolderFailed: 'Error al añadir a la carpeta',
    removeFromFolderFailed: 'Error al quitar de la carpeta',
    folderLoadFailed: 'No se pudo cargar la carpeta: HTTP {status}',
    moveToTrash: 'Mover a la papelera',
    movingProgress: 'Moviendo...',
    sharingProgress: 'Compartiendo...',
    searchFailed: 'La búsqueda falló',
    reassignFailed: 'Error al reasignar',
    addingItemsTo: 'Añadiendo elementos a:',
    addingItemsHint:
      'Marca los elementos abajo y haz clic en "Añadir a {folder}".',
    selected: 'seleccionados',
    selectedItem: 'Elemento seleccionado',
    clear: 'Borrar',
    clearFilter: 'Borrar el filtro de {filter}',
    selectAll: 'Seleccionar todos los elementos gestionables de este grupo',
    selectItem: 'Seleccionar {title}',
    reassignOwner: 'Reasignar propietario',
    reassignHeading:
      'Reasignar {count, plural, one {# elemento} other {# elementos}}',
    reassignSubheading:
      'Elige el nuevo propietario; se conservan los permisos existentes de cada elemento.',
    bulkTrashTitle: 'Mover los elementos seleccionados a la papelera',
    bulkTrashHeading:
      '¿Mover {count, plural, one {# elemento} other {# elementos}} a la papelera?',
    bulkTrashBody:
      '{count, plural, one {El elemento seleccionado se moverá a la papelera.} other {Los elementos seleccionados se moverán a la papelera.}} Puedes restaurarlos desde la página "Eliminados recientemente".',
    skippedHint:
      'Los elementos de los que no eres propietario ni administrador se omiten automáticamente.',
    bulkTrashNoneMoved:
      'No se movió ningún elemento a la papelera. Puede que no tengas derechos de administrador sobre los elementos seleccionados.',
    bulkTrashPartial:
      'Se movieron {done} elementos a la papelera; se omitieron {skipped} (sin derechos de administrador).',
    bulkShareNoneWritten:
      'No se escribió ningún permiso. Puede que no tengas derechos de administrador sobre los elementos seleccionados.',
    bulkSharePartial:
      'Se compartieron {done} elementos; se omitieron {skipped} (sin derechos de administrador).',
    bulkAccessNoneUpdated:
      'No se actualizó ningún elemento. Puede que no tengas derechos de administrador sobre los elementos seleccionados.',
    bulkAccessPartial:
      'Se actualizaron {done} elementos; se omitieron {skipped} (sin derechos de administrador).',
    shareSelectedTitle: 'Compartir elementos seleccionados',
    shareSelectedBody:
      'Cada uno de los {count} elementos seleccionados recibe su propio permiso para el destinatario que elijas. Los elementos de los que no eres propietario ni administrador se omiten automáticamente.',
    shareTabPrincipal: 'Usuario o grupo',
    shareTabOrg: 'Org.',
    shareOrgBody:
      'Cualquiera que haya iniciado sesión en tu organización podrá ver los {count} elementos seleccionados. Esto eleva el nivel de acceso del elemento; los permisos existentes de usuario / grupo se mantienen.',
    sharePublicBody:
      'Cualquiera en internet podrá ver los {count} elementos seleccionados sin iniciar sesión. Úsalo para enlaces compartibles de mapas / visores. Los elementos referenciados por la selección (capas, mapas base, etc.) también deben ser públicos; se te pedirá aplicarlo en cascada al terminar.',
    geographicScope: 'Ámbito geográfico',
    noBoundaryItems: 'Aún no hay elementos de límite en esta organización',
    noScope: 'Sin ámbito (sin restricciones)',
    geoScopeHint:
      'Cuando está definido, quienes acceden a estos elementos a través de {via} solo ven las entidades dentro del límite. Se aplica en la capa de la API.',
    geoScopeViaOrg: 'tu organización',
    geoScopeViaPublic: 'acceso público',
    recipient: 'Destinatario',
    groupTag: 'grupo',
    searchUserOrGroup: 'Busca un usuario o grupo',
    noMatchingUsersOrGroups: 'No hay usuarios ni grupos coincidentes.',
    startTypingName: 'Empieza a escribir un nombre para buscar.',
    permission: 'Permiso',
    permissionDesc: {
      view: 'Ver el elemento',
      download: 'Ver + exportar datos en bloque',
      edit: 'Ver + cambiar contenido',
      admin: 'Control total, incluido compartir',
    },
    makeOrgVisible: 'Visible para la org.',
    makePublic: 'Hacer público',
    areaBuffer: ', +{km} km de margen',
    areaLabel: 'centrado en {center} (~{width} km de ancho{buffer})',
    summaryType: 'Tipo: {labels}',
    summaryTemplate: 'Plantilla: {labels}',
    summaryArea: 'Área: {label}',
    cardView: 'Vista de tarjetas',
    cards: 'Tarjetas',
    listView: 'Vista de lista',
    list: 'Lista',
    groupBy: 'Agrupar por',
    groupNone: 'Ninguno',
    groupTypeOption: 'Tipo',
    groupAccessOption: 'Acceso',
    sortLabel: 'Ordenar',
    sort: {
      'updated-desc': 'Actualizados recientemente',
      'updated-asc': 'Actualizados hace más tiempo',
      'created-desc': 'Más nuevos primero',
      'created-asc': 'Más antiguos primero',
      'title-asc': 'Nombre (A–Z)',
      'title-desc': 'Nombre (Z–A)',
    },
    itemCount: '{count, plural, one {# elemento} other {# elementos}}',
    filteredOfTotal: '{filtered} de {total}',
    noItemsMatch: 'Ningún elemento coincide con tus filtros.',
    colTitle: 'Título',
    colType: 'Tipo',
    colOwner: 'Propietario',
    colUpdated: 'Actualizado',
    ownerYou: 'tú',
    template: {
      editor: 'Editor',
      viewer: 'Visor',
      custom: 'Personalizada',
    },
  },
  itemsPage: {
    eyebrow: 'Contenido',
    newItem: 'Nuevo elemento',
    openMap: 'Nuevo mapa',
    addItems: 'Añadir elementos',
    myItems: 'Mis elementos',
    allItems: 'Todos los elementos',
    folderBreadcrumb: 'Ruta de carpetas',
    folderDetails: 'Detalles de la carpeta →',
    emptySearchTitle: 'Ningún elemento coincide con tu búsqueda',
    emptySearchDescription:
      'Nada en {scope} coincide con "{query}". Prueba otro término o borra la búsqueda.',
    scopeYourItems: 'tus elementos',
    scopeSharedWithYou: 'los elementos compartidos contigo',
    emptyFolderTitle: '{folder} está vacía',
    emptyFolderDescription:
      'Añade elementos existentes, crea algo nuevo o arrastra elementos aquí desde la vista de todos los elementos.',
    emptyMineTitle: 'Aún no hay elementos',
    emptyMineDescription:
      'Crea tu primer mapa, formulario o capa de datos para empezar.',
    emptySharedTitle: 'Aún no han compartido nada contigo',
    emptySharedDescription:
      'Cuando un compañero comparta contenido contigo o con tu grupo, aparecerá aquí.',
    createAnItem: 'Crear un elemento',
  },
  trash: {
    restore: 'Restaurar',
    restoring: 'Restaurando',
    deleteForever: 'Eliminar para siempre',
    daysLeft: '{count, plural, one {queda # día} other {quedan # días}}',
    restoreFailed: 'Error al restaurar: {status} {detail}',
    purgeFailed: 'Error al eliminar: {status} {detail}',
    purgeConfirmTitle: '¿Eliminar permanentemente "{title}"?',
    purgeConfirmDescription:
      'Esto elimina de inmediato el elemento y todos sus permisos. Para las capas de datos también se elimina la tabla de datos subyacente. No se puede deshacer.',
  },
  dialogs: {
    confirm: 'Confirmar',
    typeToConfirmPrefix: 'Escribe',
    typeToConfirmSuffix: 'para confirmar:',
  },
  dependents: {
    checking: 'Comprobando qué depende de esto...',
    checkFailed:
      'No se pudieron comprobar los dependientes ({error}). Procede con precaución.',
    loadFailed: 'No se pudieron cargar los dependientes.',
    referencedBy:
      '{count, plural, one {# otro elemento hace referencia a esto} other {# otros elementos hacen referencia a estos}}',
    trashHint:
      'Al enviarlo a la papelera se elimina la referencia en cada uno de ellos. Puedes restaurarlo desde Eliminados recientemente si cambias de opinión.',
    moreNotShown: '+{count} más no mostrados.',
  },
  accessMatrix: {
    intro:
      'Estos elementos alimentan este compuesto en tiempo de ejecución. Cada destinatario necesita acceso de visualización en cada fila, o verá capas rotas al abrirlo.',
    filterPlaceholder: 'Filtrar elementos de dependencia...',
    countsSummary:
      '{items, plural, one {# elemento} other {# elementos}} · {sharees, plural, one {# destinatario} other {# destinatarios}}',
    grantMissing:
      'Conceder {count, plural, one {# acceso faltante} other {# accesos faltantes}}',
    noGaps: 'Sin brechas',
    itemHeader: 'Elemento',
    principalType: {
      user: 'usuario',
      group: 'grupo',
    },
    noMatches: 'Ningún elemento coincide con el filtro.',
    hasViewAccess: '{name} tiene acceso de visualización',
    grantViewTo: 'Conceder visualización a {name}',
    grantView: 'Conceder visualización',
    cannotSee: '{name} no puede ver este elemento',
    grantFailed: 'Error al conceder',
    done: 'Hecho',
  },
  sharing: {
    sharing: 'Compartir',
    dialogLabel: 'Compartición de {title}',
    whoCanSee: 'Quién puede ver esto',
    saving: 'Guardando',
    explicitShares: 'Permisos explícitos',
    noExplicitShares: 'No hay permisos individuales de usuario o grupo.',
    manageSharing: 'Gestionar compartición',
    chipTitleShared:
      '{label} · compartido con {count, plural, one {# destinatario} other {# destinatarios}}',
    youSuffix: '{label} (tú)',
    removePrincipal: 'Quitar a {label}',
    updateFailed: 'No se pudo actualizar: {status}',
    removeFailed: 'Error al quitar: {status}',
    access: {
      private: 'Privado',
      org: 'Organización',
      public: 'Público',
    },
    permission: {
      view: 'Ver',
      download: 'Descargar',
      edit: 'Editar',
      admin: 'Administrar',
    },
    expires: 'Caduca',
    expired: 'Caducado',
    neverExpires: 'Nunca caduca',
    setExpiry: 'Definir caducidad',
    expiryDialogLabel: 'Caducidad del permiso',
    days: '{count, plural, one {# día} other {# días}}',
    set: 'Definir',
  },
  picker: {
    noMatches: 'Sin coincidencias.',
    startTyping: 'Empieza a escribir para buscar.',
    unavailable: 'no disponible',
  },
  cascade: {
    title: '¿Hacer públicos también los elementos referenciados?',
    dialogLabel: 'Hacer públicos los elementos referenciados',
    body: 'ahora es público, pero hace referencia a elementos que siguen siendo privados. Los visitantes anónimos no verán esas capas hasta que cada una también se marque como pública.',
    loading: 'Cargando elementos referenciados...',
    loadFailed: 'No se pudieron cargar los elementos referenciados',
    partialFailure:
      '{failed} de {total} elementos referenciados no se pudieron hacer públicos. Inténtalo de nuevo o corrige los permisos.',
    skip: 'Omitir',
    makePublic:
      '{count, plural, one {Hacer público # elemento} other {Hacer públicos # elementos}}',
  },
  cascadeRevert: {
    title: '¿Revertir también los elementos referenciados de público?',
    dialogLabel: 'Revertir los elementos referenciados de público',
    body: 'ya no es público. Estos elementos referenciados son públicos solo por este y no los usa de forma independiente ningún otro elemento público, así que puedes retirarlos del acceso público con seguridad. Los elementos que aún alimentan otro mapa / aplicación públicos no se muestran.',
    loadFailed: 'No se pudieron cargar los candidatos a revertir',
    partialFailure:
      '{failed} de {total} elementos referenciados no se pudieron revertir. Inténtalo de nuevo o corrige los permisos.',
    revertButton:
      'Revertir {count, plural, one {# elemento} other {# elementos}} a {tier}',
  },
  reassign: {
    newOwner: 'Nuevo propietario',
    searchPlaceholder: 'Busca un usuario de tu organización…',
    pickOwner: 'Elige el nuevo propietario.',
    failed: 'Error al reasignar',
    transferTo: 'Transferir a',
    keepAccessLegend: 'Mantener el acceso del propietario anterior',
    keepView: 'Ver: el propietario anterior aún puede verlo',
    keepDownload:
      'Descargar: el propietario anterior también puede exportar datos sin procesar',
    keepEdit: 'Editar: el propietario anterior aún puede modificarlo',
    keepAdmin:
      'Administrar: el propietario anterior conserva el control total',
    keepNone: 'Ninguno: el propietario anterior pierde el acceso',
    reassign: 'Reasignar',
  },
  theme: {
    label: 'Apariencia',
    light: 'Claro',
    dark: 'Oscuro',
    system: 'Sistema',
  },
  adminBackup: {
    startFailed: 'No se pudo iniciar la copia de seguridad.',
    deleteFailed: 'No se pudo eliminar la copia de seguridad.',
    stopFailed: 'No se pudo detener la copia de seguridad.',
    stop: 'Detener',
    stopping: 'Deteniendo...',
    stopTitle:
      'Pedir a esta copia de seguridad que se detenga. No se publica nada hasta que una copia termina, así que detenerla siempre es seguro.',
    fileMissing: 'El archivo ya no está en el servidor',
    fileMissingTitle:
      'Esta copia de seguridad terminó, pero su archivo ya no está en la carpeta de copias. Puede que se haya movido, eliminado a mano o que pertenezca a una restauración anterior de la base de datos. No se puede descargar ni restaurar.',
  },
  welcome: {
    title: 'Bienvenido a GratisGIS',
    intro: 'Tu espacio de trabajo está vacío. Elige por dónde empezar.',
    createMap: 'Crear un mapa',
    createMapDesc: 'Empieza con un mapa en blanco sobre el mapa base predeterminado.',
    uploadData: 'Subir datos',
    uploadDataDesc: 'Importa GeoJSON, Shapefile o CSV como una capa de datos.',
    loadSample: 'Cargar datos de ejemplo',
    loadSampleDesc:
      'Explora un espacio de trabajo listo del condado de Randolph: capas, mapas, un formulario, aplicaciones y un levantamiento de campo.',
    loading: 'Cargando datos de ejemplo...',
    loaded: '{count, plural, one {# elemento de ejemplo creado} other {# elementos de ejemplo creados}}',
    allSkipped: 'Los datos de ejemplo ya están cargados',
    failed: 'No se pudieron cargar los datos de ejemplo',
    dismiss: 'Descartar el panel de bienvenida',
  },
};
