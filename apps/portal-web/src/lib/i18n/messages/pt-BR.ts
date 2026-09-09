// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 1.1 Brazilian Portuguese catalog.
 *
 * Machine-translated seed (initial pass 2026-06-01). Native
 * speakers: please review and refine. Open a pull request with
 * fixes; the locale picker tags this locale "MT" until a native
 * speaker has signed off. See CONTRIBUTING-TRANSLATIONS.md.
 *
 * Conventions: Brazilian Portuguese (not European). Casual second
 * person ("você") to match the source English's friendly tone.
 */
import type { CatalogShape } from '../locales';

export const ptBR: Partial<CatalogShape> = {
  common: {
    save: 'Salvar',
    cancel: 'Cancelar',
    delete: 'Excluir',
    close: 'Fechar',
    edit: 'Editar',
    loading: 'Carregando…',
    backToItems: 'Voltar aos itens',
    settings: 'Configurações',
    language: 'Idioma',
  },
  nav: {
    items: 'Itens',
    home: 'Início',
    admin: 'Administração',
    profile: 'Perfil',
    signOut: 'Sair',
    signIn: 'Entrar',
    overview: 'Visão geral',
    folders: 'Pastas',
    groups: 'Grupos',
    recentlyDeleted: 'Excluídos recentemente',
    users: 'Usuários',
    landingPage: 'Página inicial',
    backup: 'Backup',
    housekeeping: 'Manutenção',
    notifications: 'Notificações',
    fieldQueues: 'Filas de campo',
    migrations: 'Migrações',
    gettingStarted: 'Primeiros passos',
  },
  shell: {
    notificationsLabel: 'Notificações',
    navigation: 'Navegação',
    openNavigation: 'Abrir navegação',
    closeNavigation: 'Fechar navegação',
  },
  search: {
    placeholder: 'Pesquisar itens...',
    label: 'Pesquisar itens',
  },
  help: {
    buttonTitle: 'Ajuda (pressione ? a qualquer momento)',
    openLabel: 'Abrir ajuda',
  },
  newItem: {
    pageTitle: 'Criar um novo item',
    pageIntro:
      'Escolha o que você está criando e preencha os detalhes. Para serviços e uploads, vamos coletar o necessário na próxima tela para que o item fique pronto para uso.',
    createButton: 'Criar item',
    backButton: 'Voltar',
    viewerBlocked:
      'Sua conta tem a função Visualizador, que pode abrir e baixar itens, mas não criá-los. Um administrador da organização pode alterar sua função ou conceder apenas a capacidade de publicar.',
  },
  newItemJob: {
    data_layer:
      'Comece aqui se você tem uma planilha, um shapefile ou um arquivo GeoJSON para enviar.',
    map: 'Comece aqui para colocar em um mapa dados que você já enviou e compartilhá-lo.',
    form: 'Comece aqui se você quer que as pessoas preencham respostas, uma por vez, a partir de um link que você envia.',
    data_collection:
      'Comece aqui se você quer que uma equipe registre em um mapa o que encontra, pelo celular, offline.',
  },
  metadataXml: {
    intro:
      'Preencha previamente título, descrição e etiquetas a partir de um arquivo {term}, do tipo que o ArcGIS, o QGIS ou um catálogo de dados público exporta junto com um conjunto de dados. Reconhece ISO 19115, FGDC CSDGM e Dublin Core.',
    term: 'XML de metadados',
    importTitle:
      'Importe um arquivo XML de metadados exportado pelo ArcGIS, QGIS ou por um catálogo de dados (ISO 19115, FGDC CSDGM ou Dublin Core) para preencher previamente os campos abaixo',
  },
  layerBuilder: {
    tableName: 'Nome da tabela',
    tableNameTitle:
      'O nome desta camada no banco de dados e nos endereços web. Em minúsculas, com sublinhados no lugar de espaços.',
    dropToImport: 'Solte para importar.',
    dropHint: 'Solte um arquivo aqui ou clique para escolher um.',
    importUsual:
      'O mais comum é uma planilha salva como CSV, com uma coluna de latitude e uma de longitude.',
    importAlso:
      'Também: TSV · GeoJSON · GeoParquet (.parquet) · KML / KMZ (Google Earth) · GeoPackage (.gpkg, somente tabelas vetoriais) · Shapefile (.zip) · File Geodatabase (.gdb.zip)',
  },
  mapEditor: {
    legendButton: 'Legenda',
    tableButton: 'Tabela de atributos',
    markupButton: 'Anotações',
    commentsButton: 'Comentários',
    printButton: 'Imprimir este mapa',
    layerAccessButton: 'Acesso às camadas',
    saveMapButton: 'Salvar mapa',
    savedIndicator: 'Salvo',
  },
  featureEdit: {
    groupLabel: 'Editar',
    editShape: 'Editar forma',
    addFeature: 'Adicionar feição',
    deleteFeature: 'Excluir feição',
    layerToAddTo: 'Camada de destino',
    snappingOn: 'Ajuste ativado',
    snappingOff: 'Ajuste desativado',
    hintEdit:
      'Clique em uma feição de uma camada editável para mover seus vértices.',
    hintLoading: 'Carregando a feição...',
    hintDelete: 'Clique em uma feição de uma camada editável para excluí-la.',
    hintAddPoint: 'Clique no mapa para posicionar a feição.',
    hintAddPath:
      'Clique para adicionar vértices; clique duas vezes ou clique no primeiro vértice para concluir.',
    editingIn:
      'Editando uma feição em {layer}. Arraste os vértices; clique em um ponto médio para adicionar um.',
    cancel: 'Cancelar',
    saveShape: 'Salvar forma',
    shapeSaved: 'Forma salva.',
    featureAdded: 'Feição adicionada.',
    featureDeleted: 'Feição excluída.',
    newFeatureTitle: 'Nova feição',
    newFeatureAttributes: 'Atributos da nova feição',
    addAction: 'Adicionar feição',
    deleteConfirmTitle: 'Excluir esta feição?',
    deleteConfirmMessage:
      'Ela será removida de "{layer}". Isso não pode ser desfeito daqui.',
    deleteAction: 'Excluir',
    noStableId:
      'Esta feição não tem um id estável e não pode ser editada aqui.',
    noGeometry: 'Esta camada não tem geometria para editar.',
    notFound: 'Não foi possível encontrar essa feição no servidor.',
    loadFailed: 'Não foi possível carregar a feição',
    saveFailed: 'Falha ao salvar',
    deleteFailed: 'Falha ao excluir',
    addFailed: 'Não foi possível adicionar a feição',
    unnamedLayer: 'camada',
  },
  presence: {
    youSuffix: ' (você)',
  },
  comments: {
    title: 'Comentários',
    showResolved: 'Mostrar resolvidos',
    startThread: 'Iniciar um novo tópico...',
    post: 'Publicar',
    reply: 'Responder...',
    resolve: 'Resolver',
    reopen: 'Reabrir',
    threadCount: '{count, plural, one {# tópico} other {# tópicos}}',
    noOpen:
      'Nenhum tópico aberto. Ative "Mostrar resolvidos" para ver os fechados.',
    noComments:
      'Ainda sem comentários. Inicie a conversa abaixo.',
    signInPrompt: 'Entre para comentar neste mapa.',
  },
  markup: {
    title: 'Anotações',
    add: 'Adicionar anotação',
    empty:
      'Sem anotações ainda. Adicione um conjunto e então coloque marcadores para anotar o mapa.',
    dropPin: 'Colocar marcador no centro',
    signInPrompt: 'Entre para adicionar anotações neste mapa.',
  },
  print: {
    chooserTitle: 'Imprimir este mapa',
    startSection: 'Criar um novo layout',
    startAction:
      'Criar um novo layout de impressão vinculado a este mapa',
    startHint:
      'Abre o designer de layout de impressão com este mapa já conectado aos elementos Mapa, Legenda, Escala e Seta de norte.',
    pickSection: 'Usar um layout existente',
    pickEmpty:
      'Ainda não há layouts de impressão disponíveis. Use "Criar um novo layout" acima para criar um.',
  },
  errors: {
    generic: 'Algo deu errado',
    unauthorized: 'Entre para continuar',
    notFound: 'Não encontrado',
    sessionExpired:
      'Seu login expirou. Entre novamente para ver tudo a que você tem acesso.',
  },
  errorReason: {
    unknown: 'erro desconhecido',
  },
  addToFolder: {
    heading: 'Adicionar {count, plural, one {# item} other {# itens}} a uma pasta',
    searchPlaceholder: 'Pesquisar pastas',
    noMatches: 'Nenhuma pasta corresponde.',
    itemCount: '{count, plural, one {# item} other {# itens}}',
  },
  areaSearch: {
    title: 'Pesquisar por área',
    hint: 'Arraste e amplie; a lista é atualizada automaticamente.',
    close: 'Fechar pesquisa por área',
    myLocation: 'Minha localização',
    myLocationTitle: 'Centralizar o mapa na sua localização atual',
    padAreaBy: 'Ampliar a área em',
    searching: 'Pesquisando...',
    refreshNow: 'Atualizar agora',
  },
  dataPreview: {
    title: 'Pré-visualização de dados',
    eyebrow: 'Pré-visualização',
    openItem: 'Abrir item',
    closePreview: 'Fechar pré-visualização',
    layer: 'Camada',
    layerLabel: 'Camada:',
    table: 'tabela',
    tableSuffix: '(tabela)',
    noFeatures: 'Nenhuma feição nesta camada.',
    featureCount: '{count, plural, one {# feição} other {# feições}}',
    featureCountOverflow: '{count}+ de muitas feições',
    fieldCount: '{count, plural, one {# campo} other {# campos}}',
    overflowNotice:
      'Mostrando as primeiras {limit} feições. Abra o editor de mapas do item para ver a tabela de atributos completa.',
    upstreamError: 'A origem retornou um erro',
    loadFailed:
      'Não foi possível carregar a pré-visualização. Abra o item para ver os detalhes.',
  },
  filter: {
    filter: 'Filtrar',
    filterItems: 'Filtrar itens',
    activeCount:
      '{count, plural, one {# filtro ativo} other {# filtros ativos}}',
    type: 'Tipo',
    clearTypes: 'Limpar tipos',
    noItemsToFilter: 'Nenhum item para filtrar na visualização atual.',
    template: 'Modelo',
    owner: 'Proprietário',
    access: 'Acesso',
    area: 'Área',
    clearArea: 'Limpar área',
    filterByArea: 'Filtrar por área...',
    filteringByArea: 'Filtrando por área',
    clearAll: 'Limpar todos os filtros',
  },
  folders: {
    hide: 'Ocultar pastas',
  },
  folderRail: {
    newButton: '+ Nova',
    collapse: 'Recolher pasta',
    expand: 'Expandir pasta',
    folderNamePlaceholder: 'Nome da pasta',
    emptyPrefix: 'Ainda não há pastas.',
    createOne: 'Crie uma',
    emptySuffix: 'para organizar seus itens.',
    moveFailedTitle: 'Falha ao mover',
    moveFailedMessage: 'Não foi possível mover o item.',
  },
  folderMenu: {
    actionsFor: 'Ações para {folder}',
    moreActions: 'Mais ações',
    share: 'Compartilhar...',
    newSubfolder: 'Nova subpasta',
    trashTitle: 'Mover a pasta para a lixeira?',
    trashMessage:
      'Mover "{folder}" para a lixeira? O conteúdo da pasta permanece onde está; apenas a organização em pastas é removida.',
    trashMessageCascade:
      'Mover "{folder}" e as subpastas listadas para a lixeira? Os itens que não são pastas permanecem onde estão; apenas a organização em pastas é removida.',
    subfoldersAlsoTrashed:
      '{count, plural, one {# subpasta também será movida para a lixeira:} other {# subpastas também serão movidas para a lixeira:}}',
    andMore: '...e mais {count}.',
    unlinkedItems:
      '{count, plural, one {# outro item dentro perderá a referência à pasta, mas o item em si permanece.} other {# outros itens dentro perderão a referência à pasta, mas os itens em si permanecem.}}',
    multiParentNote:
      'Subpastas que também estão arquivadas em outra pasta sobreviverão a esta exclusão e não são listadas.',
    trashing: 'Movendo...',
    trashFailedTitle: 'Não foi possível mover para a lixeira',
    trashFailedMessage: 'Falha ao mover para a lixeira: {status}',
  },
  field: {
    nav: 'Campo',
    qrAlt: 'Código QR com link para esta implantação',
    qrHint:
      'Aponte a câmera de um celular para isto para abrir a implantação nesse dispositivo.',
    qrSignIn: 'Na primeira vez, você precisará entrar no celular.',
    copyLink: 'Copiar link',
    copied: 'Copiado',
    openOnPhone: 'Abrir em um celular',
  },
  fieldQueue: {
    rejectedChip:
      '{count, plural, one {# edição precisa de atenção} other {# edições precisam de atenção}}',
    rejectedChipTitle:
      'O servidor recusou estas edições. Abra para ver o motivo e tentar de novo ou descartá-las.',
    rejectedTitle: 'Edições que o servidor recusou',
    rejectedIntro:
      'Estas edições foram enviadas, mas não aceitas, e enviá-las de novo sem alterações teria a mesma resposta. Corrija o que a mensagem indica e tente de novo, ou descarte a edição.',
    rejectedEmpty: 'Nada aqui. Todas as edições foram aceitas.',
    op: {
      insert: 'Nova feição em {layer}',
      update: 'Alteração em uma feição de {layer}',
      delete: 'Exclusão em {layer}',
    },
    unknownLayer: 'uma camada que não está mais nesta implantação',
    noReason: 'O servidor não disse o motivo.',
    retry: 'Tentar de novo',
    retryAll: 'Tentar de novo todas as {count}',
    discard: 'Descartar',
    discardTitle: 'Descartar esta edição?',
    discardMessage:
      'Ela existe apenas neste dispositivo. Depois de descartada, não pode ser recuperada.',
    discardAction: 'Descartar edição',
    close: 'Fechar',
  },
  fieldAttachments: {
    heading: 'Fotos e arquivos',
    headingCount: 'Fotos e arquivos · {count}',
    add: 'Adicionar foto',
    emptyCanCapture:
      'Ainda sem fotos. Elas ficam neste dispositivo e são enviadas com o registro.',
    emptyReadOnly: 'Nenhuma foto neste registro.',
    pendingBadge: 'No dispositivo',
    pendingBadgeTitle: 'Aguardando envio',
    discardLabel: 'Descartar {name}',
    discardTitle: 'Descartar este arquivo?',
    discardMessage:
      '{name} ainda não foi enviado. Descartá-lo o remove deste dispositivo e ele não pode ser recuperado.',
    discardAction: 'Descartar',
    quotaError:
      'Não há mais espaço neste dispositivo para outra foto. Sincronize ou libere espaço primeiro.',
    saveError: 'Não foi possível salvar o arquivo: {reason}',
  },
  fieldCollect: {
    cancel: 'Cancelar',
    submit: 'Enviar',
    addTitle: 'Nova feição: {layer}',
    editTitle: 'Editar feição: {layer}',
    addAria: 'Adicionar {layer}',
    editAria: 'Editar {layer}',
    discardTitle: 'Descartar este registro?',
    discardMessage:
      'Você inseriu informações que não foram salvas. Descartá-las não pode ser desfeito.',
    discardAction: 'Descartar',
    discardCancel: 'Continuar editando',
  },
  fieldRuntime: {
    pickTypeSheet: 'Escolha um tipo de feição para adicionar',
    featureDetailsSheet: 'Detalhes da feição',
    queueReadFailed: 'Não foi possível ler a fila offline.',
  },
  fieldGps: {
    accuracy: 'Precisão do GPS {meters} m',
    denied:
      'A localização está bloqueada. Permita-a nas configurações do navegador para capturar na sua posição.',
    unavailable:
      'A localização não está disponível neste dispositivo. As feições serão posicionadas no centro do mapa.',
  },
  fieldOffline: {
    partial: 'Incompleto. Não baixado: {missing}.',
    partialOutOfSpace:
      'Incompleto: o armazenamento acabou. Não baixado: {missing}.',
    partialMissingMore: '{missing} e mais {count}',
    quotaTitle: 'Armazenamento insuficiente para este download',
    quotaBody:
      'Este download precisa de cerca de {needed} e faltam ~{short}. Libere implantações em cache ou espaço no dispositivo, ou reduza o nível de detalhe, e tente de novo.',
    identityTitle: 'Trabalho não sincronizado de outra conta',
    identityBody:
      'Este dispositivo contém {records, plural, =0 {nenhum registro} one {# registro não sincronizado} other {# registros não sincronizados}} e {files, plural, =0 {nenhuma foto} one {# foto} other {# fotos}} capturados por outra conta. Eles não chegaram ao servidor.',
    identityKeepExplain:
      'Se você os mantiver aqui, eles ficam guardados neste dispositivo, fora das suas contagens de sincronização, e são enviados quando essa conta entrar de novo.',
    identityRemoveExplain:
      'Se você os remover, eles são excluídos deste dispositivo. Nada mais guarda uma cópia.',
    identityKeep: 'Manter aqui',
    identityRemove: 'Remover deste dispositivo',
    identityRemoved:
      '{records, plural, one {# registro} other {# registros}} e {files, plural, one {# foto} other {# fotos}} removidos deste dispositivo.',
    identityRemoveFailed: 'Não foi possível remover os dados da outra conta.',
    removeWillLose:
      '{count, plural, one {# edição não sincronizada será perdida.} other {# edições não sincronizadas serão perdidas.}}',
    removeWillLoseOthers:
      '{count, plural, one {# delas pertence a outra conta.} other {# delas pertencem a outra conta.}}',
  },
  signOut: {
    unsyncedTitle: 'Sair com trabalho não sincronizado?',
    unsyncedMessage:
      '{count, plural, one {# edição neste dispositivo ainda não chegou ao servidor. Ela ficará neste dispositivo, mas ninguém mais pode enviá-la por você.} other {# edições neste dispositivo ainda não chegaram ao servidor. Elas ficarão neste dispositivo, mas ninguém mais pode enviá-las por você.}} Sincronize antes de sair se conseguir uma conexão.',
    unsyncedConfirm: 'Sair mesmo assim',
    unsyncedCancel: 'Continuar conectado',
  },
  itemDetail: {
    accessPrivate: 'Privado',
    accessOrg: 'Organização',
    accessPublic: 'Público',
    accessPrivateTitle: 'Somente você e as pessoas com quem você compartilhar',
    accessOrgTitle: 'Todos que estão conectados a este portal',
    accessPublicTitle: 'Qualquer pessoa na internet, sem precisar entrar',
    licenseTitle: 'Licença: {license}',
    statFeatures: 'Feições',
    statGeometry: 'Forma',
    statCoordinates: 'Coordenadas',
    statFields: 'Campos',
    statLayers: 'Camadas',
    statUpdated: 'Atualizado',
    statFeaturesTitle:
      'Contadas ao vivo e limitadas ao que você tem acesso, então pode ser menor que o total publicado.',
    statCoordinatesTitle:
      'Armazenadas como latitude e longitude (EPSG:4326). {source}',
    statCoordinatesFrom: 'Convertidas de {srs} na importação.',
    statCoordinatesNative: 'Foi assim que chegaram.',
    statCoordinatesUnknown:
      'O arquivo de origem não informava, então se assumiu que já eram latitude e longitude.',
    statUnavailable: 'Não disponível',
    statMixed: 'Misto',
    geometryPoint: 'Pontos',
    geometryLine: 'Linhas',
    geometryPolygon: 'Áreas',
    geometryNone: 'Tabela, sem formas',
    previewTitle: 'Pré-visualização',
    previewEmpty: 'Nada para desenhar ainda',
    previewEmptyHint:
      'Esta camada não tem feições com localização, então não há nada para mostrar em um mapa.',
    previewFailed: 'Não foi possível carregar a pré-visualização',
    previewLoading: 'Carregando a pré-visualização',
  },
  itemTabs: {
    overview: 'Visão geral',
    data: 'Dados',
    structure: 'Estrutura',
    source: 'Origem',
    metadata: 'Metadados',
    access: 'Compartilhar',
    sections: 'Seções do item',
  },
  mapCard: {
    editTitle: 'Mapa',
    editBody:
      'Abra o mapa para navegar, ampliar e explorar a tabela de atributos, e para adicionar camadas, definir o mapa base e organizar a tela.',
    editAction: 'Abrir mapa',
    viewTitle: 'Mapa',
    viewBody:
      'Abra este mapa para navegar, ampliar, trocar de mapa base e explorar a tabela de atributos. Você tem acesso de visualização, então nada que você alterar aqui é salvo.',
    viewAction: 'Abrir mapa',
  },
  appCard: {
    editTitle: 'Aplicativo web personalizado',
    editBody:
      'Abra o construtor para arrastar widgets para a tela, organizar páginas e vincular camadas de dados.',
    editAction: 'Abrir construtor',
    viewTitle: 'Aplicativo web',
    viewBody: 'Abra este aplicativo e use-o como seus leitores o veem.',
    viewAction: 'Abrir aplicativo',
  },
  groupItems: {
    title: 'Compartilhado com este grupo',
    empty:
      'Nada foi compartilhado com este grupo ainda. Compartilhe um item com o grupo pela aba Compartilhar dele e ele aparecerá aqui.',
    openItem: 'Abrir detalhes do item',
    removeAction: 'Remover deste grupo',
    removeTitle: 'Remover do grupo',
    removeBody:
      'Remover "{title}" deste grupo? Os membros do grupo perdem o acesso que este compartilhamento concedia; o item em si não é alterado.',
    removeConfirm: 'Remover',
    removed: '"{title}" removido do grupo.',
    removeFailed: 'Não foi possível remover o item: HTTP {status}.',
  },
  housekeepingTabs: {
    review: 'Revisar',
    cleanup: 'Limpeza',
    starters: 'Modelos iniciais',
    schedule: 'Agendamento',
    sections: 'Seções de manutenção',
  },
  v3Editor: {
    structureTitle: 'Estrutura da camada',
    structureIntro:
      'Edite camadas, campos, domínios e restrições aqui. Salvar tem efeito imediato; importar e explorar linhas fica na aba Dados.',
    dataTitle: 'Dados da camada',
    dataIntro: 'Explore as linhas de cada camada, adicione mais dados ou baixe-os.',
  },
  layerExport: {
    format: {
      csv: 'CSV',
      xlsx: 'Excel',
      geojson: 'GeoJSON',
      geoparquet: 'GeoParquet',
    },
    exported:
      '{count, plural, one {# linha exportada} other {# linhas exportadas}} como {format}.',
    failed: 'A exportação para {format} falhou',
    nothingLoaded: 'Nada para exportar: esta camada não tem linhas carregadas.',
    nothingSelected: 'Nada para exportar: nenhuma linha está selecionada.',
    exportRows: 'Exportar {count, plural, one {# linha} other {# linhas}}',
    noRows: 'Nenhuma linha para exportar',
  },
  addToMap: {
    newMap: 'Novo mapa',
    existingMap: 'Um mapa existente',
    loadingMaps: 'Carregando mapas...',
    noMaps: 'Nenhum mapa ainda',
    layerGone: '{item} não tem mais uma camada "{layerKey}".',
    tableNoShapes:
      '{layer} é uma tabela sem formas, então não há nada para desenhar.',
  },
  mapSearch: {
    geocoderUnavailable:
      'A busca de lugares está indisponível no momento ({reason}). Os resultados de camadas acima não são afetados.',
    noPlaces:
      'Nenhum lugar encontrado para isso. O geocodificador deste portal cobre apenas a área com a qual foi configurado.',
  },
  adminFieldQueues: {
    rejectedByServer: '{count} recusados pelo servidor',
    queuedSummary: '{queued} na fila ({failed} com falha)',
    queuedSummaryWithRejected:
      '{queued} na fila ({failed} com falha, {rejected} recusados)',
    rejectedWaiting: 'recusado, aguardando o worker',
    moreWithErrors: '+ {count} outros registros com erros.',
  },
  metadataPanel: {
    description: 'Descrição',
    noDescription:
      'Ainda sem descrição. Uma frase sobre o que é isto e de onde veio é a diferença entre um item que alguém reutiliza e um que alguém recria.',
    tags: 'Etiquetas',
    noTags: 'Sem etiquetas.',
    type: 'Tipo',
    owner: 'Proprietário',
    created: 'Criado',
    updated: 'Atualizado',
    license: 'Licença',
    source: 'Origem',
    sourceFormat: 'Formato de origem',
    originalProjection: 'Projeção original',
    itemId: 'ID do item',
    storageScope: 'Escopo de armazenamento',
    storageScopeFor: 'Escopo: {layer}',
    storageTable: 'Tabela de armazenamento',
    notRecorded: 'Não registrado',
    copyTitle: 'Copiar {label}',
    formatGeojson: 'GeoJSON',
    formatGeoparquet: 'GeoParquet',
    formatKml: 'KML',
    formatKmz: 'KMZ',
    formatShapefile: 'Shapefile',
    formatGdb: 'File geodatabase',
    formatXlsx: 'Planilha do Excel',
    formatCsv: 'CSV',
    formatManual: 'Inserido manualmente',
    formatApi: 'Carregado pela API',
  },
  copyButton: {
    copy: 'Copiar',
    copied: 'Copiado',
  },
  offlineAreas: {
    title: 'Áreas offline',
    intro:
      'O portal prepara um arquivo de mapa por área, então um condado inteiro é um único download de alguns megabytes em vez de um milhão de solicitações separadas.',
    addArea: 'Adicionar área',
    loading: 'Carregando áreas...',
    noneYet: 'Nenhuma área ainda.',
    noneYetNoExtent:
      'Adicione alguns dados ao mapa implantado primeiro, para que haja uma extensão a preparar.',
    noneYetHint:
      'Adicione uma e os coletores poderão levar esta implantação offline.',
    extentSummary: 'cerca de {width} por {height} milhas',
    rebuildsEvery: 'reconstruída a cada {days} dias',
    waiting: 'Aguardando para começar...',
    preparingCount: 'Preparando {count} tiles...',
    preparing: 'Preparando...',
    ready: 'Pronta',
    builtOn: 'criada em {date}',
    buildFailed: 'Não foi possível preparar.',
    notPrepared: 'Ainda não preparada.',
    prepareAgain: 'Preparar de novo',
    prepareNow: 'Preparar agora',
    deleteArea: 'Excluir área',
    deleteTitle: 'Excluir esta área?',
    deleteBody:
      'Os coletores não poderão mais baixar "{name}". O que já estiver em um dispositivo permanece lá.',
    name: 'Nome',
    namePlaceholder: 'Levantamento de verão, equipe norte...',
    detailLabel: 'Quanto detalhe',
    detailHint:
      'Os coletores sempre podem ampliar além disso. A partir de certo ponto, o mapa apenas deixa de adicionar novos rótulos.',
    refreshLabel: 'Manter atualizado',
    refreshManual: 'Somente quando eu pedir',
    refreshWeekly: 'Semanalmente',
    refreshMonthly: 'Mensalmente',
    refreshQuarterly: 'A cada três meses',
    detailRoads: 'Estradas e cidades',
    detailRoadsHint: 'Menor download',
    detailStreets: 'Ruas locais',
    detailPaths: 'Nomes de ruas e caminhos',
    detailPathsHint: 'Recomendado para trabalho de campo',
    detailBuildings: 'Contornos de edifícios',
    detailBuildingsHint: 'Maior download',
    tooBig:
      'Esta área é grande demais nesse nível de detalhe. Escolha menos detalhe ou divida a implantação em mais de uma área.',
    sizeEstimate:
      'Cobre {extent}. Aproximadamente {size} para baixar. O valor exato é medido antes de qualquer preparação.',
    cancel: 'Cancelar',
    addAndPrepare: 'Adicionar e preparar',
    saveFailed: 'Não foi possível salvar a área: {status}',
    buildStartFailed: 'Não foi possível iniciar a preparação: {status}',
  },
  offlineBasemap: {
    preparedMap: 'Mapa preparado',
    preparedMaps: 'Mapas preparados',
    onThisDevice: 'Neste dispositivo',
    includedWithSize: '{size}, incluído no download acima',
    included: 'Incluído no download acima',
    removeFromDevice: 'Remover deste dispositivo',
    removeAria: 'Remover {name} deste dispositivo',
    explainer:
      'O líder da sua equipe preparou estes mapas, então eles chegam como arquivos únicos em vez de pedaço por pedaço, e são desenhados sem nenhum sinal.',
    unsupported:
      'Este navegador não consegue armazenar mapas offline. Tente adicionar o aplicativo à sua tela inicial.',
    preparedNoticeOne:
      'O mapa desta implantação já está preparado, então ele chega como um único arquivo.',
    preparedNoticeMany:
      'Os mapas desta implantação já estão preparados, então eles chegam como arquivos únicos.',
    downloadStopped:
      'Download interrompido. O que já foi salvo continua neste dispositivo.',
  },
  itemMenu: {
    actions: 'Ações do item',
    open: 'Abrir',
    responses: 'Respostas',
    configure: 'Configurar',
    previewData: 'Pré-visualizar dados',
    addToMap: 'Adicionar ao mapa',
    addLayerToMapTitle: 'Adicionar apenas esta camada a um mapa',
    moveToFolder: 'Mover para pasta',
    removeFromFolder: 'Remover desta pasta',
    removeFromNamedFolder: 'Remover de "{folder}"',
  },
  itemForm: {
    itemType: 'Tipo de item',
    title: 'Título',
    titlePlaceholder: 'Minha camada, relatório, formulário...',
    titleRequired: 'O título é obrigatório.',
    description: 'Descrição',
    descriptionPlaceholder: 'O que é isto, e para quem é?',
    tags: 'Etiquetas',
    tagsPlaceholder: 'Separadas por vírgulas, p. ex. edifícios, lotes, campus',
    tagsHint: 'Usadas para pesquisa e filtragem.',
    thumbnail: 'Miniatura',
    visibility: 'Visibilidade',
    visibilityHintCreate:
      'Você pode alterar isso depois e adicionar compartilhamentos explícitos na página de detalhes do item.',
    visibilityHintEdit:
      'Refine com compartilhamentos por usuário ou por grupo na página de detalhes.',
    license: 'Licença',
    licenseHintPrefix:
      'Como outras pessoas podem reutilizar este item. Exibido no catálogo de dados abertos da organização',
    licenseHintSuffix: 'para itens públicos.',
    licenseCustomPlaceholder:
      'Id SPDX ou URL da licença (p. ex. https://creativecommons.org/licenses/by/4.0/)',
    recipe: 'Receita',
    pickSourceLayer:
      'Escolha uma camada de dados de origem para esta camada derivada.',
    addPipelineStep:
      'Adicione pelo menos uma etapa de ferramenta ao pipeline.',
    saveFailed: '{method} falhou: {status} {detail}',
    saveChanges: 'Salvar alterações',
    type: {
      map: {
        label: 'Mapa',
        desc: 'Um mapa base + camadas sobrepostas com estilos.',
      },
      data_layer: {
        label: 'Camada de dados',
        desc: 'Uma camada vetorial compartilhável baseada em PostGIS.',
      },
      arcgis_service: {
        label: 'Serviço ArcGIS',
        desc: 'Ponteiro ao vivo para um MapServer ou FeatureServer do ArcGIS.',
      },
      form: {
        label: 'Formulário',
        desc: 'Um formulário de coleta para trabalho de campo ou pesquisas.',
      },
      web_app: {
        label: 'Aplicativo web',
        desc: 'Um aplicativo configurável construído com widgets.',
      },
      report_template: {
        label: 'Modelo de relatório',
        desc: 'Um modelo de documento que renderiza dados.',
      },
      dashboard: {
        label: 'Painel',
        desc: 'Painéis ao vivo mostrando dados de feições.',
      },
      file: {
        label: 'Arquivo',
        desc: 'Qualquer arquivo enviado (PDF, imagem, zip, etc.).',
      },
    },
    access: {
      private: {
        label: 'Privado',
        desc: 'Somente você e as pessoas com quem compartilhar.',
      },
      org: {
        label: 'Sua organização',
        desc: 'Qualquer pessoa com uma conta na sua organização.',
      },
      public: { label: 'Público', desc: 'Qualquer pessoa na internet.' },
    },
    licenseOption: {
      notSpecified: {
        label: 'Não especificada',
        hint: 'Tratada como "direitos reservados"',
      },
      cc0: { label: 'CC0 (domínio público)', hint: 'Nenhum direito reservado' },
      ccBy: { label: 'CC BY 4.0', hint: 'Reutilização com atribuição' },
      ccBySa: {
        label: 'CC BY-SA 4.0',
        hint: 'Atribuição + compartilhamento igual',
      },
      ccByNc: { label: 'CC BY-NC 4.0', hint: 'Atribuição, não comercial' },
      oglUk: {
        label: 'Licença de Governo Aberto do Reino Unido v3',
        hint: '',
      },
      odbl: { label: 'Open Database License 1.0', hint: '' },
      mit: {
        label: 'MIT',
        hint: 'Permissiva; comum também para conjuntos de dados',
      },
      proprietary: {
        label: 'Proprietária / direitos reservados',
        hint: 'Somente uso interno',
      },
      custom: { label: 'Personalizada…', hint: 'Especifique seu próprio valor' },
    },
  },
  items: {
    share: 'Compartilhar',
    adding: 'Adicionando...',
    addToFolder: 'Adicionar a pasta',
    addToNamedFolder: 'Adicionar a {folder}',
    addToFolderFailed: 'Falha ao adicionar à pasta',
    removeFromFolderFailed: 'Falha ao remover da pasta',
    folderLoadFailed: 'Não foi possível carregar a pasta: HTTP {status}',
    moveToTrash: 'Mover para a lixeira',
    movingProgress: 'Movendo...',
    sharingProgress: 'Compartilhando...',
    searchFailed: 'A pesquisa falhou',
    reassignFailed: 'Falha ao reatribuir',
    addingItemsTo: 'Adicionando itens a:',
    addingItemsHint:
      'Marque os itens abaixo e clique em "Adicionar a {folder}".',
    selected: 'selecionados',
    selectedItem: 'Item selecionado',
    clear: 'Limpar',
    clearFilter: 'Limpar o filtro de {filter}',
    selectAll: 'Selecionar todos os itens gerenciáveis deste grupo',
    selectItem: 'Selecionar {title}',
    reassignOwner: 'Reatribuir proprietário',
    reassignHeading:
      'Reatribuir {count, plural, one {# item} other {# itens}}',
    reassignSubheading:
      'Escolha o novo proprietário; os compartilhamentos existentes de cada item são preservados.',
    bulkTrashTitle: 'Mover os itens selecionados para a lixeira',
    bulkTrashHeading:
      'Mover {count, plural, one {# item} other {# itens}} para a lixeira?',
    bulkTrashBody:
      '{count, plural, one {O item selecionado será movido para a lixeira.} other {Os itens selecionados serão movidos para a lixeira.}} Você pode restaurá-los na página "Excluídos recentemente".',
    skippedHint:
      'Itens dos quais você não é proprietário nem administrador são ignorados automaticamente.',
    bulkTrashNoneMoved:
      'Nenhum item foi movido para a lixeira. Talvez você não tenha direitos de administrador sobre os itens selecionados.',
    bulkTrashPartial:
      '{done} itens movidos para a lixeira; {skipped} ignorados (sem direitos de administrador).',
    bulkShareNoneWritten:
      'Nenhum compartilhamento foi gravado. Talvez você não tenha direitos de administrador sobre os itens selecionados.',
    bulkSharePartial:
      '{done} itens compartilhados; {skipped} ignorados (sem direitos de administrador).',
    bulkAccessNoneUpdated:
      'Nenhum item foi atualizado. Talvez você não tenha direitos de administrador sobre os itens selecionados.',
    bulkAccessPartial:
      '{done} itens atualizados; {skipped} ignorados (sem direitos de administrador).',
    shareSelectedTitle: 'Compartilhar itens selecionados',
    shareSelectedBody:
      'Cada um dos {count} itens selecionados recebe seu próprio compartilhamento para o destinatário escolhido. Itens dos quais você não é proprietário nem administrador são ignorados automaticamente.',
    shareTabPrincipal: 'Usuário ou grupo',
    shareTabOrg: 'Org.',
    shareOrgBody:
      'Qualquer pessoa conectada à sua organização poderá ver os {count} itens selecionados. Isso eleva o nível de acesso do item; os compartilhamentos de usuário / grupo existentes são mantidos.',
    sharePublicBody:
      'Qualquer pessoa na internet poderá ver os {count} itens selecionados sem fazer login. Use isto para links compartilháveis de mapas / visualizadores. Os itens referenciados pela seleção (camadas, mapas base, etc.) também precisam ser públicos; você será solicitado a aplicar em cascata ao concluir.',
    geographicScope: 'Escopo geográfico',
    noBoundaryItems: 'Ainda não há itens de limite nesta organização',
    noScope: 'Sem escopo (irrestrito)',
    geoScopeHint:
      'Quando definido, quem acessa estes itens via {via} vê apenas as feições dentro do limite. Aplicado na camada da API.',
    geoScopeViaOrg: 'sua organização',
    geoScopeViaPublic: 'acesso público',
    recipient: 'Destinatário',
    groupTag: 'grupo',
    searchUserOrGroup: 'Pesquise um usuário ou grupo',
    noMatchingUsersOrGroups: 'Nenhum usuário ou grupo correspondente.',
    startTypingName: 'Comece a digitar um nome para pesquisar.',
    permission: 'Permissão',
    permissionDesc: {
      view: 'Ver o item',
      download: 'Ver + exportar dados em massa',
      edit: 'Ver + alterar conteúdo',
      admin: 'Controle total, incluindo compartilhamento',
    },
    makeOrgVisible: 'Visível para a org.',
    makePublic: 'Tornar público',
    areaBuffer: ', +{km} km de margem',
    areaLabel: 'centrado em {center} (~{width} km de largura{buffer})',
    summaryType: 'Tipo: {labels}',
    summaryTemplate: 'Modelo: {labels}',
    summaryArea: 'Área: {label}',
    cardView: 'Visualização em cartões',
    cards: 'Cartões',
    listView: 'Visualização em lista',
    list: 'Lista',
    groupBy: 'Agrupar por',
    groupNone: 'Nenhum',
    groupTypeOption: 'Tipo',
    groupAccessOption: 'Acesso',
    sortLabel: 'Ordenar',
    sort: {
      'updated-desc': 'Atualizados recentemente',
      'updated-asc': 'Atualizados há mais tempo',
      'created-desc': 'Mais novos primeiro',
      'created-asc': 'Mais antigos primeiro',
      'title-asc': 'Nome (A–Z)',
      'title-desc': 'Nome (Z–A)',
    },
    itemCount: '{count, plural, one {# item} other {# itens}}',
    filteredOfTotal: '{filtered} de {total}',
    noItemsMatch: 'Nenhum item corresponde aos seus filtros.',
    colTitle: 'Título',
    colType: 'Tipo',
    colOwner: 'Proprietário',
    colUpdated: 'Atualizado',
    ownerYou: 'você',
    template: {
      editor: 'Editor',
      viewer: 'Visualizador',
      custom: 'Personalizado',
    },
  },
  itemsPage: {
    eyebrow: 'Conteúdo',
    newItem: 'Novo item',
    openMap: 'Novo mapa',
    addItems: 'Adicionar itens',
    myItems: 'Meus itens',
    allItems: 'Todos os itens',
    folderBreadcrumb: 'Trilha de pastas',
    folderDetails: 'Detalhes da pasta →',
    emptySearchTitle: 'Nenhum item corresponde à sua pesquisa',
    emptySearchDescription:
      'Nada em {scope} corresponde a "{query}". Tente outro termo ou limpe a pesquisa.',
    scopeYourItems: 'seus itens',
    scopeSharedWithYou: 'os itens compartilhados com você',
    emptyFolderTitle: '{folder} está vazia',
    emptyFolderDescription:
      'Adicione itens existentes, crie algo novo ou arraste itens para cá a partir da visualização de todos os itens.',
    emptyMineTitle: 'Ainda não há itens',
    emptyMineDescription:
      'Crie seu primeiro mapa, formulário ou camada de dados para começar.',
    emptySharedTitle: 'Nada foi compartilhado com você ainda',
    emptySharedDescription:
      'Quando um colega compartilhar conteúdo com você ou seu grupo, ele aparecerá aqui.',
    createAnItem: 'Criar um item',
  },
  trash: {
    restore: 'Restaurar',
    restoring: 'Restaurando',
    deleteForever: 'Excluir para sempre',
    daysLeft: '{count, plural, one {resta # dia} other {restam # dias}}',
    restoreFailed: 'Falha ao restaurar: {status} {detail}',
    purgeFailed: 'Falha ao excluir: {status} {detail}',
    purgeConfirmTitle: 'Excluir permanentemente "{title}"?',
    purgeConfirmDescription:
      'Isto remove imediatamente o item e todos os compartilhamentos associados. Para camadas de dados, a tabela de dados subjacente também é removida. Não é possível desfazer.',
  },
  dialogs: {
    confirm: 'Confirmar',
    typeToConfirmPrefix: 'Digite',
    typeToConfirmSuffix: 'para confirmar:',
  },
  dependents: {
    checking: 'Verificando o que depende disto...',
    checkFailed:
      'Não foi possível verificar os dependentes ({error}). Prossiga com cautela.',
    loadFailed: 'Não foi possível carregar os dependentes.',
    referencedBy:
      '{count, plural, one {# outro item faz referência a isto} other {# outros itens fazem referência a estes}}',
    trashHint:
      'Mover para a lixeira remove a referência de cada um deles. Você pode restaurar em Excluídos recentemente se mudar de ideia.',
    moreNotShown: '+{count} a mais não exibidos.',
  },
  accessMatrix: {
    intro:
      'Estes itens alimentam este composto em tempo de execução. Cada destinatário precisa de acesso de visualização em cada linha, ou verá camadas quebradas ao abri-lo.',
    filterPlaceholder: 'Filtrar itens de dependência...',
    countsSummary:
      '{items, plural, one {# item} other {# itens}} · {sharees, plural, one {# destinatário} other {# destinatários}}',
    grantMissing:
      'Conceder {count, plural, one {# acesso faltante} other {# acessos faltantes}}',
    noGaps: 'Sem lacunas',
    itemHeader: 'Item',
    principalType: {
      user: 'usuário',
      group: 'grupo',
    },
    noMatches: 'Nenhum item corresponde ao filtro.',
    hasViewAccess: '{name} tem acesso de visualização',
    grantViewTo: 'Conceder visualização a {name}',
    grantView: 'Conceder visualização',
    cannotSee: '{name} não pode ver este item',
    grantFailed: 'Falha ao conceder',
    done: 'Concluído',
  },
  sharing: {
    sharing: 'Compartilhamento',
    dialogLabel: 'Compartilhamento de {title}',
    whoCanSee: 'Quem pode ver isto',
    saving: 'Salvando',
    explicitShares: 'Compartilhamentos explícitos',
    noExplicitShares:
      'Nenhum compartilhamento individual de usuário ou grupo.',
    manageSharing: 'Gerenciar compartilhamento',
    chipTitleShared:
      '{label} · compartilhado com {count, plural, one {# destinatário} other {# destinatários}}',
    youSuffix: '{label} (você)',
    removePrincipal: 'Remover {label}',
    updateFailed: 'Não foi possível atualizar: {status}',
    removeFailed: 'Falha ao remover: {status}',
    access: {
      private: 'Privado',
      org: 'Organização',
      public: 'Público',
    },
    permission: {
      view: 'Ver',
      download: 'Baixar',
      edit: 'Editar',
      admin: 'Administrar',
    },
    expires: 'Expira',
    expired: 'Expirado',
    neverExpires: 'Nunca expira',
    setExpiry: 'Definir expiração',
    expiryDialogLabel: 'Expiração do compartilhamento',
    days: '{count, plural, one {# dia} other {# dias}}',
    set: 'Definir',
  },
  picker: {
    noMatches: 'Sem correspondências.',
    startTyping: 'Comece a digitar para pesquisar.',
    unavailable: 'indisponível',
  },
  cascade: {
    title: 'Tornar públicos também os itens referenciados?',
    dialogLabel: 'Tornar públicos os itens referenciados',
    body: 'agora é público, mas faz referência a itens que ainda são privados. Visitantes anônimos não verão essas camadas até que cada uma também seja marcada como pública.',
    loading: 'Carregando itens referenciados...',
    loadFailed: 'Falha ao carregar os itens referenciados',
    partialFailure:
      '{failed} de {total} itens referenciados não puderam ser tornados públicos. Tente novamente ou corrija as permissões.',
    skip: 'Pular',
    makePublic:
      '{count, plural, one {Tornar # item público} other {Tornar # itens públicos}}',
  },
  cascadeRevert: {
    title: 'Reverter também os itens referenciados do acesso público?',
    dialogLabel: 'Reverter os itens referenciados do acesso público',
    body: 'não é mais público. Estes itens referenciados são públicos apenas por causa deste e não são usados de forma independente por nenhum outro item público; portanto, você pode retirá-los do acesso público com segurança. Itens que ainda alimentam outro mapa / aplicativo público não são exibidos.',
    loadFailed: 'Falha ao carregar os candidatos à reversão',
    partialFailure:
      '{failed} de {total} itens referenciados não puderam ser revertidos. Tente novamente ou corrija as permissões.',
    revertButton:
      'Reverter {count, plural, one {# item} other {# itens}} para {tier}',
  },
  reassign: {
    newOwner: 'Novo proprietário',
    searchPlaceholder: 'Pesquise um usuário da sua organização…',
    pickOwner: 'Escolha o novo proprietário.',
    failed: 'Falha ao reatribuir',
    transferTo: 'Transferir para',
    keepAccessLegend: 'Manter o acesso do proprietário anterior',
    keepView: 'Ver: o proprietário anterior ainda pode vê-lo',
    keepDownload:
      'Baixar: o proprietário anterior também pode exportar dados brutos',
    keepEdit: 'Editar: o proprietário anterior ainda pode alterá-lo',
    keepAdmin:
      'Administrar: o proprietário anterior mantém o controle total',
    keepNone: 'Nenhum: o proprietário anterior perde o acesso',
    reassign: 'Reatribuir',
  },
  theme: {
    label: 'Aparência',
    light: 'Claro',
    dark: 'Escuro',
    system: 'Sistema',
  },
  adminBackup: {
    startFailed: 'Não foi possível iniciar o backup.',
    deleteFailed: 'Não foi possível excluir o backup.',
    stopFailed: 'Não foi possível interromper o backup.',
    stop: 'Interromper',
    stopping: 'Interrompendo...',
    stopTitle:
      'Pedir que este backup seja interrompido. Nada é publicado até um backup terminar, então interromper é sempre seguro.',
    fileMissing: 'Arquivo não está mais no servidor',
    fileMissingTitle:
      'Este backup terminou, mas seu arquivo não está mais na pasta de backups. Ele pode ter sido movido, excluído manualmente ou pertencer a uma restauração anterior do banco de dados. Não pode ser baixado nem restaurado.',
  },
  welcome: {
    title: 'Bem-vindo ao GratisGIS',
    intro: 'Seu espaço de trabalho está vazio. Escolha por onde começar.',
    createMap: 'Criar um mapa',
    createMapDesc: 'Comece com um mapa em branco sobre o mapa base padrão.',
    uploadData: 'Enviar dados',
    uploadDataDesc: 'Importe GeoJSON, Shapefile ou CSV como uma camada de dados.',
    loadSample: 'Carregar dados de exemplo',
    loadSampleDesc:
      'Explore um espaço de trabalho pronto do condado de Randolph: camadas, mapas, um formulário, aplicativos e um levantamento de campo.',
    loading: 'Carregando dados de exemplo...',
    loaded: '{count, plural, one {# item de exemplo criado} other {# itens de exemplo criados}}',
    allSkipped: 'Os dados de exemplo já estão carregados',
    failed: 'Não foi possível carregar os dados de exemplo',
    dismiss: 'Dispensar o painel de boas-vindas',
  },
};
