import type {
  Finding, ProjectObject, Protocol, ReasonCode, UploadedFile
} from '../types';

/* ─────────── Словари русских подписей ─────────── */

export const statusLabels: Record<string, string> = {
  CANDIDATE:              'Кандидат',
  CONFIRMED_VIOLATION:    'Нарушение подтверждено',
  NEGATIVE_VERIFIED:      'Проверено, расхождений нет',
  MISSING_EVIDENCE:       'Нет доказательства',
  NOT_APPLICABLE:         'Неприменимо',
  NOT_COMPARABLE:         'Нельзя сопоставить',
  CLARIFICATION_REQUIRED: 'Требует уточнения',
  SUSPICION:              'Гипотеза'
};

export const processStatusLabels: Record<string, string> = {
  PENDING:   'Ожидает обработки',
  PARSING:   'Обработка',
  READY:     'Готов к верификации',
  VERIFYING: 'Верификация',
  COMPLETED: 'Завершён',
  FINALIZED: 'Финализирован'
};

export const approvalLabels: Record<string, string> = {
  DRAFT: 'Черновик',
  APPROVED: 'Утверждён',
  FOR_CONSTRUCTION: 'В производство работ',
  SUPERSEDED: 'Заменён',
  CANCELLED: 'Отменён'
};

export const reasonLabels: Record<ReasonCode, string> = {
  WRONG_REVISION:   'Актуальная редакция выбрана неверно',
  APPROVED_CHANGE:  'Есть согласованное изменение',
  OCR_ERROR:        'Ошибка OCR',
  BINDING_ERROR:    'Ошибка привязки',
  NOT_APPLICABLE:   'Параметр неприменим',
  OTHER:            'Иное'
};

export const reasonCodes: ReasonCode[] = [
  'WRONG_REVISION', 'APPROVED_CHANGE', 'OCR_ERROR',
  'BINDING_ERROR', 'NOT_APPLICABLE', 'OTHER'
];

export const uploadErrors = [
  'Файл превышает 50 МБ',
  'Превышен общий лимит пакета — 200 МБ',
  'Неподдерживаемый формат файла. Допустимы PDF, DOCX, XML',
  'Файл повреждён или защищён паролем',
  'Не удалось прочитать сопроводительный реестр'
];

export const inspector = {
  name: 'Смирнов А.В.',
  role: 'Государственный инспектор',
  org: 'Мосгосстройнадзор'
};

/* ─────────── Объекты ─────────── */

export const objects: ProjectObject[] = [
  { id:'obj-altuf',       name:'Торговое здание, реконструкция', address:'г. Москва, Алтуфьевское шоссе, д. 79Б, стр. 1',
    developer:'ООО «СтройИнвест-М»', permit:'РС-77-123456-2024',
    completeness:{ PD:'full', RD:'partial', ID:'missing' },
    processStatus:'READY', candidates:14, confirmed:3, updatedAt:'14.11.2025 10:22', indicator:'yellow' },

  { id:'obj-polyar-25-doo', name:'ДОО, Полярная, 25', address:'г. Москва, ул. Полярная, д. 25',
    developer:'ГБУ «Мосстройразвитие»', permit:'РС-77-234567-2024',
    completeness:{ PD:'full', RD:'full', ID:'partial' },
    processStatus:'VERIFYING', candidates:9, confirmed:0, updatedAt:'13.11.2025 16:45', indicator:'yellow' },

  { id:'obj-polyar-25-school', name:'СОШ, Полярная, 25', address:'г. Москва, ул. Полярная, д. 25, корп. 2',
    developer:'ГБУ «Мосстройразвитие»', permit:'РС-77-234568-2024',
    completeness:{ PD:'full', RD:'full', ID:'full' },
    processStatus:'FINALIZED', candidates:0, confirmed:0, updatedAt:'12.11.2025 09:10', indicator:'green' },

  { id:'obj-polyar-16', name:'Жилой дом, Полярная, 16', address:'г. Москва, ул. Полярная, д. 16',
    developer:'АО «Мосинжпроект»', permit:'РС-77-345678-2024',
    completeness:{ PD:'full', RD:'full', ID:'missing' },
    processStatus:'VERIFYING', candidates:22, confirmed:4, updatedAt:'13.11.2025 11:30', indicator:'red' },

  { id:'obj-polyar-17', name:'Жилой дом, Полярная, 17', address:'г. Москва, ул. Полярная, д. 17',
    developer:'АО «Мосинжпроект»', permit:'РС-77-345679-2024',
    completeness:{ PD:'full', RD:'full', ID:'full' },
    processStatus:'FINALIZED', candidates:0, confirmed:0, updatedAt:'10.11.2025 18:00', indicator:'green' },

  { id:'obj-oct-103', name:'Жилой дом, Октябрьская, 103', address:'г. Москва, ул. Октябрьская, д. 103',
    developer:'ООО «ГлавСтройГрупп»', permit:'РС-77-456789-2024',
    completeness:{ PD:'full', RD:'partial', ID:'missing' },
    processStatus:'READY', candidates:6, confirmed:1, updatedAt:'11.11.2025 14:15', indicator:'red' },

  { id:'obj-losev-3a', name:'Жилой дом, Лосевская, 3А', address:'г. Москва, ул. Лосевская, д. 3А',
    developer:'ООО «ДСК-1»', permit:'РС-77-567890-2024',
    completeness:{ PD:'full', RD:'full', ID:'partial' },
    processStatus:'VERIFYING', candidates:4, confirmed:0, updatedAt:'12.11.2025 08:45', indicator:'yellow' },

  { id:'obj-undms', name:'Здание КПП, УНДМС', address:'г. Москва, ул. Петровка, д. 38',
    developer:'ФГУП «Охрана» Росгвардии', permit:'РС-77-678901-2023',
    completeness:{ PD:'full', RD:'missing', ID:'missing' },
    processStatus:'PENDING', candidates:0, confirmed:0, updatedAt:'05.11.2025 12:00', indicator:'yellow' }
];

export const dashboardSummary = {
  objectsInWork: 12,
  awaitingVerification: 4,
  candidatesToReview: 37,
  finalizedThisMonth: 8
};

/* ─────────── Файлы загрузки ─────────── */

const pdCodes = ['П-АР','П-КР','П-ОВ','П-ВК','П-ИОС5.4.2','П-ПЗ','П-ЭОМ','П-ТХ','П-ПБ','П-АК','П-СС','П-ОДИ'];
const pdMarks = ['АР','КР','ОВ','ВК','ИОС','ПЗ','ЭОМ','ТХ','ПБ','АК','СС','ОДИ'];

export const uploadedFiles: UploadedFile[] = [
  ...Array.from({ length: 12 }, (_, i): UploadedFile => ({
    id: `pd-${i + 1}`,
    name: `${pdCodes[i]}.pdf`,
    stage: 'PD',
    mark: pdMarks[i],
    code: `АНО/150321/1-${pdCodes[i]}`,
    revision: `Ред. ${(i % 3) + 1}`,
    approvalStatus: 'APPROVED',
    sheets: 20 + i * 3,
    size: `${(2.1 + i * 0.7).toFixed(1)} МБ`,
    sha256: sha(i)
  })),
  ...Array.from({ length: 5 }, (_, i): UploadedFile => ({
    id: `rd-${i + 1}`,
    name: `РД-${String(i + 1).padStart(2, '0')}-${['АР','ОВ1','ОВ2.1','КР','ВК'][i]}.pdf`,
    stage: 'RD',
    mark: ['АР','ОВ1','ОВ2.1','КР','ВК'][i],
    code: `АНО/150321/1-РД-${['АР','ОВ1','ОВ2.1','КР','ВК'][i]}`,
    revision: `Ред. ${i % 2 === 0 ? 2 : 1}`,
    approvalStatus: 'FOR_CONSTRUCTION',
    sheets: 15 + i * 4,
    size: `${(3.4 + i * 0.9).toFixed(1)} МБ`,
    sha256: sha(i + 12)
  }))
];

function sha(seed: number): string {
  const alphabet = 'abcdef0123456789';
  let out = '';
  for (let i = 0; i < 64; i++) {
    out += alphabet[(seed * 31 + i * 17) % alphabet.length];
  }
  return out;
}

/* ─────────── Evidence ─────────── */

const pdEvidence = {
  sha256: sha(1),
  stage: 'PD' as const,
  documentCode: 'АНО/150321/1-П-АР',
  revision: 'Ред. 1',
  approvalStatus: 'APPROVED' as const,
  sheetPage: 21,
  bbox: [0.42, 0.33, 0.58, 0.41] as [number, number, number, number],
  extractedValue: '1,20 м',
  role: 'expected' as const
};

const rdEvidence = {
  sha256: sha(13),
  stage: 'RD' as const,
  documentCode: 'АНО/150321/1-РД-АР',
  revision: 'Ред. 2',
  approvalStatus: 'FOR_CONSTRUCTION' as const,
  sheetPage: 4,
  bbox: [0.51, 0.45, 0.64, 0.55] as [number, number, number, number],
  extractedValue: '0,85 м',
  role: 'actual' as const
};

/* ─────────── Кандидаты ─────────── */

export const findings: Finding[] = [
  {
    id:'f-002', code:'M-002', section:'ПЗ',
    title:'Общая площадь здания', unit:'м²',
    expected:'2 797,27 м²', actual:'2 811,40 м²',
    delta:'+0,51 %', trigger:'Расхождение > 0,5 %',
    normReference:'СП 54.13330.2022', approvedChange: null,
    aiRationale:'Общая площадь здания в рабочей документации превышает значение проектной документации на 14,13 м² (0,51 %). Отклонение находится на границе допустимого порога и требует решения инспектора.',
    priority:'MEDIUM', status:'CANDIDATE', sources:['PD','RD'],
    expectedEvidence:{ ...pdEvidence, extractedValue:'2 797,27 м²' },
    actualEvidence:{ ...rdEvidence, extractedValue:'2 811,40 м²' }
  },
  {
    id:'f-047', code:'M-047', section:'АР',
    title:'Ширина эвакуационных дверей', unit:'м',
    expected:'≥ 1,20 м', actual:'0,85 м',
    delta:'−0,35 м', trigger:'Ширина < 0,9 м',
    normReference:'СП 1.13130.2020, п. 4.2.1', approvedChange: null,
    aiRationale:'Фактическая ширина эвакуационной двери в рабочей документации составляет 0,85 м, что ниже нормативного минимума 0,9 м согласно СП 1.13130.2020. Выявлено расхождение между проектной документацией (требуемая ширина 1,20 м) и рабочей (фактическая 0,85 м).',
    priority:'HIGH', status:'CANDIDATE', sources:['PD','RD'],
    expectedEvidence: pdEvidence,
    actualEvidence: rdEvidence
  },
  {
    id:'f-055', code:'M-055', section:'КР',
    title:'Класс прочности бетона', unit:'класс',
    expected:'B25', actual:'B20',
    delta:'−1 класс', trigger:'Понижение класса',
    normReference:'СП 63.13330.2018', approvedChange: null,
    aiRationale:'Класс бетона в рабочей документации понижен на одну ступень относительно проектного значения (B25 → B20), что может повлиять на несущую способность конструкции.',
    priority:'HIGH', status:'CANDIDATE', sources:['PD','RD'],
    expectedEvidence:{ ...pdEvidence, extractedValue:'B25' },
    actualEvidence:{ ...rdEvidence, extractedValue:'B20' }
  },
  {
    id:'f-101', code:'M-101', section:'ОВ',
    title:'Контуры тёплого пола, МГН 267/270/271/272', unit:'контуров',
    expected:'2 контура', actual:'отсутствуют',
    delta:'−2', trigger:'Отсутствие элемента',
    normReference:'СП 60.13330.2020', approvedChange: null,
    aiRationale:'В рабочей документации отсутствуют контуры тёплого пола в помещениях МГН, предусмотренные проектом (ПД лист 21, два контура).',
    priority:'HIGH', status:'CANDIDATE', sources:['PD','RD'],
    expectedEvidence:{ ...pdEvidence, documentCode:'АНО/150321/1-П-ОВ', sheetPage:21, extractedValue:'2 контура' },
    actualEvidence:{ ...rdEvidence, documentCode:'АНО/150321/1-РД-ОВ2.1', sheetPage:4, extractedValue:'—' }
  },
    {
    id:'f-118', code:'M-118', section:'ОВ',
    title:'Местные отсосы, помещения 140 и 142', unit:'ветвей',
    expected:'6 ветвей (В2.4–В2.9)', actual:'0 (общеобмен)',
    delta:'−6', trigger:'Отсутствие элемента',
    normReference:'СП 60.13330.2020', approvedChange: null,
    aiRationale:'В рабочей документации вместо шести ветвей местных отсосов запроектирована только общеобменная вентиляция П2/ВЕ. Кандидат составной: 6 ветвей требуется рассмотреть отдельными находками.',
    priority:'HIGH', status:'CANDIDATE', sources:['PD','RD'],
    expectedEvidence:{ ...pdEvidence, documentCode:'АНО/150321/1-П-ОВ', sheetPage:10, extractedValue:'В2.4–В2.9' },
    actualEvidence:{ ...rdEvidence, documentCode:'АНО/150321/1-РД-ОВ1', sheetPage:4, extractedValue:'П2/ВЕ' },
    composite: {
      note: 'Составной кандидат. Подтвердить нарушение целиком нельзя — разбейте на атомарные находки.',
      atoms: [
        { id:'atom-118-1', code:'M-118.1', title:'Местный отсос, помещение 140, ветвь В2.4', expected:'1', actual:'0', delta:'−1' },
        { id:'atom-118-2', code:'M-118.2', title:'Местный отсос, помещение 140, ветвь В2.5', expected:'1', actual:'0', delta:'−1' },
        { id:'atom-118-3', code:'M-118.3', title:'Местный отсос, помещение 140, ветвь В2.6', expected:'1', actual:'0', delta:'−1' },
        { id:'atom-118-4', code:'M-118.4', title:'Местный отсос, помещение 142, ветвь В2.7', expected:'1', actual:'0', delta:'−1' },
        { id:'atom-118-5', code:'M-118.5', title:'Местный отсос, помещение 142, ветвь В2.8', expected:'1', actual:'0', delta:'−1' },
        { id:'atom-118-6', code:'M-118.6', title:'Местный отсос, помещение 142, ветвь В2.9', expected:'1', actual:'0', delta:'−1' }
      ]
    }
  },
    {
    id:'f-122', code:'M-122', section:'ОВ',
    title:'Конфигурация приточных установок, венткамера 012', unit:'—',
    expected:'ПД лист 26', actual:'РД ОВ1 л. 3',
    delta:'—', trigger:'Смена компоновки',
    normReference:'СП 60.13330.2020', approvedChange: null,
    aiRationale:'Компоновка приточных установок в рабочей документации отличается от проекта. Загружено две редакции РД с разной компоновкой — требуется выбор актуальной редакции.',
    priority:'MEDIUM', status:'CANDIDATE', sources:['PD','RD'],
    expectedEvidence:{ ...pdEvidence, documentCode:'АНО/150321/1-П-ОВ', sheetPage:26 },
    actualEvidence:{ ...rdEvidence, documentCode:'АНО/150321/1-РД-ОВ1', sheetPage:3 },
    clarificationConflict: {
      revisions: [
        {
          sha256: sha(13),
          documentCode: 'АНО/150321/1-РД-ОВ1',
          revision: 'Ред. 1',
          approvalStatus: 'APPROVED',
          approvedAt: '12.10.2025',
          sheetPage: 3,
          extractedValue: 'П2/ВЕ — совпадает с ПД'
        },
        {
          sha256: sha(14),
          documentCode: 'АНО/150321/1-РД-ОВ1',
          revision: 'Ред. 2',
          approvalStatus: 'FOR_CONSTRUCTION',
          approvedAt: '28.10.2025',
          sheetPage: 3,
          extractedValue: 'П2/ВЕ-И — иная компоновка'
        }
      ]
    }
  },
  {
    id:'f-201', code:'M-201', section:'АР',
    title:'Высота помещений техэтажа', unit:'м',
    expected:'2,50 м', actual:'2,40 м',
    delta:'−0,10 м', trigger:'Ниже норматива',
    normReference:'СП 118.13330.2022', approvedChange: null,
    aiRationale:'Высота помещения технического этажа в РД ниже проектного значения и ниже нормативного минимума.',
    priority:'MEDIUM', status:'CANDIDATE', sources:['PD','RD'],
    expectedEvidence:{ ...pdEvidence, extractedValue:'2,50 м' },
    actualEvidence:{ ...rdEvidence, extractedValue:'2,40 м' }
  },
  {
    id:'f-210', code:'M-210', section:'АР',
    title:'Площадь помещений пищеблока', unit:'м²',
    expected:'124,50 м²', actual:'118,20 м²',
    delta:'−5,06 %', trigger:'Расхождение > 5 %',
    normReference:'СП 118.13330.2022', approvedChange: null,
    aiRationale:'Фактическая площадь помещений пищеблока сокращена на 6,3 м² относительно проекта.',
    priority:'HIGH', status:'CANDIDATE', sources:['PD','RD'],
    expectedEvidence:{ ...pdEvidence, extractedValue:'124,50 м²' },
    actualEvidence:{ ...rdEvidence, extractedValue:'118,20 м²' }
  },
  {
    id:'f-301', code:'M-301', section:'КР',
    title:'Диаметр рабочей арматуры плиты', unit:'мм',
    expected:'Ø16 A500C', actual:'Ø14 A500C',
    delta:'−2 мм', trigger:'Понижение класса',
    normReference:'СП 63.13330.2018', approvedChange: null,
    aiRationale:'В рабочей документации уменьшен диаметр рабочей арматуры плиты перекрытия, что может снизить несущую способность.',
    priority:'HIGH', status:'CANDIDATE', sources:['PD','RD'],
    expectedEvidence:{ ...pdEvidence, extractedValue:'Ø16 A500C' },
    actualEvidence:{ ...rdEvidence, extractedValue:'Ø14 A500C' }
  },
  {
    id:'f-305', code:'M-305', section:'КР',
    title:'Защитный слой бетона', unit:'мм',
    expected:'30 мм', actual:'22 мм',
    delta:'−8 мм', trigger:'Ниже норматива',
    normReference:'СП 63.13330.2018', approvedChange: null,
    aiRationale:'Защитный слой бетона в РД занижен относительно проектного значения.',
    priority:'MEDIUM', status:'CANDIDATE', sources:['PD','RD'],
    expectedEvidence:{ ...pdEvidence, extractedValue:'30 мм' },
    actualEvidence:{ ...rdEvidence, extractedValue:'22 мм' }
  },
  {
    id:'f-401', code:'M-401', section:'ИОС',
    title:'Протяжённость сети водоснабжения', unit:'м',
    expected:'142,30 м', actual:'151,80 м',
    delta:'+6,7 %', trigger:'Расхождение > 5 %',
    normReference:'СП 30.13330.2020', approvedChange: null,
    aiRationale:'Протяжённость сети водоснабжения в РД превышает проектное значение более чем на 5 %.',
    priority:'LOW', status:'CANDIDATE', sources:['PD','RD'],
    expectedEvidence:{ ...pdEvidence, extractedValue:'142,30 м' },
    actualEvidence:{ ...rdEvidence, extractedValue:'151,80 м' }
  },
  {
    id:'f-501', code:'M-501', section:'ПБ',
    title:'Количество эвакуационных выходов', unit:'шт.',
    expected:'2', actual:'1',
    delta:'−1', trigger:'Ниже норматива',
    normReference:'СП 1.13130.2020', approvedChange: null,
    aiRationale:'Количество эвакуационных выходов в рабочей документации меньше проектного значения.',
    priority:'HIGH', status:'CANDIDATE', sources:['PD','RD'],
    expectedEvidence:{ ...pdEvidence, extractedValue:'2' },
    actualEvidence:{ ...rdEvidence, extractedValue:'1' }
  },
  /* Уже подтверждённые инспектором — для вкладки «Подтверждённые нарушения» */
  {
    id:'f-601', code:'M-601', section:'АР',
    title:'Отсутствие лифтовой шахты', unit:'шт.',
    expected:'1', actual:'0',
    delta:'−1', trigger:'Отсутствие элемента',
    normReference:'СП 54.13330.2022', approvedChange: null,
    aiRationale:'В РД отсутствует лифтовая шахта, предусмотренная проектом.',
    priority:'HIGH', status:'CONFIRMED_VIOLATION', sources:['PD','RD'],
    expectedEvidence: pdEvidence, actualEvidence: rdEvidence,
    decision: { status:'CONFIRMED_VIOLATION', inspector:'Смирнов А.В.', timestamp:'14.11.2025 10:42' }
  },
  {
    id:'f-602', code:'M-602', section:'ПБ',
    title:'Ширина лестничного марша', unit:'м',
    expected:'≥ 1,35 м', actual:'1,10 м',
    delta:'−0,25 м', trigger:'Ниже норматива',
    normReference:'СП 1.13130.2020', approvedChange: null,
    aiRationale:'Ширина лестничного марша занижена относительно норматива.',
    priority:'HIGH', status:'CONFIRMED_VIOLATION', sources:['PD','RD'],
    expectedEvidence: pdEvidence, actualEvidence: rdEvidence,
    decision: { status:'CONFIRMED_VIOLATION', inspector:'Смирнов А.В.', timestamp:'14.11.2025 10:48' }
  },
  {
    id:'f-603', code:'M-603', section:'КР',
    title:'Класс бетона фундамента', unit:'класс',
    expected:'B30', actual:'B25',
    delta:'−1 класс', trigger:'Понижение класса',
    normReference:'СП 63.13330.2018', approvedChange: null,
    aiRationale:'Класс бетона фундамента понижен относительно проекта.',
    priority:'HIGH', status:'CONFIRMED_VIOLATION', sources:['PD','RD'],
    expectedEvidence: pdEvidence, actualEvidence: rdEvidence,
    decision: { status:'CONFIRMED_VIOLATION', inspector:'Смирнов А.В.', timestamp:'14.11.2025 10:55' }
  },
  /* Гипотезы свободного поиска — для пятой вкладки */
  {
    id:'f-h01', code:'H-01', section:'АР',
    title:'В РД отсутствует лифтовая шахта при 15 этажах', unit:'—',
    expected:'—', actual:'—', delta:'—', trigger:'ML-паттерн',
    normReference:'СП 54.13330.2022', approvedChange: null,
    aiRationale:'Модель обнаружила отсутствие лифтовой шахты в РД при 15 этажах здания.',
    priority:'MEDIUM', status:'SUSPICION', sources:['PD','RD'], 
    detectionMethod: 'ml',   
    confidence: 0.87,
    expectedEvidence: pdEvidence, actualEvidence: rdEvidence
  },
  {
    id:'f-h02', code:'H-02', section:'ТХ',
    title:'В ПД помещение техническое, в РД — склад ГСМ', unit:'—',
    expected:'—', actual:'—', delta:'—', trigger:'Семантический диссонанс',
    normReference:'СП 4.13130.2013', approvedChange: null,
    aiRationale:'Семантическое расхождение назначения помещения между ПД и РД.',
    priority:'HIGH', status:'SUSPICION', sources:['PD','RD'], detectionMethod: 'semantic',   
    confidence: 0.74,
    expectedEvidence: pdEvidence, actualEvidence: rdEvidence
  },
  {
    id:'f-h03', code:'H-03', section:'АР',
    title:'Высота помещений 2,4 м при нормативных 2,5 м', unit:'—',
    expected:'—', actual:'—', delta:'—', trigger:'Нормативный анализ',
    normReference:'СП 118.13330.2022', approvedChange: null,
    aiRationale:'Нормативное несоответствие высоты помещений.',
    priority:'MEDIUM', status:'SUSPICION', sources:['PD','RD'], detectionMethod: 'normative',   
    confidence: 0.92,
    expectedEvidence: pdEvidence, actualEvidence: rdEvidence
  },
  {
    id:'f-h04', code:'H-04', section:'КР',
    title:'Расход бетона на 20 % ниже среднего', unit:'—',
    expected:'—', actual:'—', delta:'—', trigger:'ML-паттерн',
    normReference:'—', approvedChange: null,
    aiRationale:'Расход бетона ниже среднего по аналогичным объектам на 20 %.',
    priority:'LOW', status:'SUSPICION', sources:['RD'], detectionMethod: 'ml',   
    confidence: 0.61,
    expectedEvidence: rdEvidence, actualEvidence: rdEvidence
  },
  {
    id:'f-h05', code:'H-05', section:'ПБ',
    title:'Отсутствует система дымоудаления при длине коридора > 15 м', unit:'—',
    expected:'—', actual:'—', delta:'—', trigger:'Логический анализ',
    normReference:'СП 7.13130.2013', approvedChange: null,
    aiRationale:'Логический анализ выявил отсутствие системы дымоудаления.',
    priority:'HIGH', status:'SUSPICION', sources:['PD','RD'], detectionMethod: 'logical',   
    confidence: 0.88,
    expectedEvidence: pdEvidence, actualEvidence: rdEvidence
  }
];

/* ─────────── Протокол ─────────── */

export const protocol: Protocol = {
  id:'p-2025-0147',
  number:'2025-0147',
  objectId:'obj-altuf',
  createdAt:'14.11.2025 10:14',
  version:1,
  processStatus:'READY',
  matrixVersion:'1.1',
  modelVersion:'0.4.2',
  datasetVersion:'2025-08',
  hash:'a3f9c1d2e4b6f8a1c3e5d7b9f1a3c5e7d9b1f3a5c7e9d1b3f5a7c9e1d3b5f7',
  summary: { checked:132, candidates:14, confirmed:3, negative:96, noEvidence:12, notApplicable:7 },
  findings
};

/* ─────────── Обработка (Э4) ─────────── */

export const processingStages = [
  { key:'ocr',  label:'Распознавание (OCR)',      done:true,  counter:'143 из 143 листов' },
  { key:'nlp',  label:'Извлечение значений (NLP)', done:true,  counter:'411 значений' },
  { key:'cv',   label:'Анализ чертежей (CV)',      active:true, counter:'18 из 26 чертежей' },
  { key:'cmp',  label:'Сопоставление 132 параметров', done:false, counter:'—' }
];

export const processingLog = [
  { time:'14:02:11', text:'АНО/150321/1-РД-ОВ1 · распознано 18 листов', warn:false },
  { time:'14:02:34', text:'АНО/150321/1-П-АР · распознано 21 лист',    warn:false },
  { time:'14:02:58', text:'АНО/150321/1-РД-АР · извлечено 44 значения', warn:false },
  { time:'14:03:12', text:'АНО/150321/1-П-КР · извлечено 32 значения',  warn:false },
  { time:'14:03:27', text:'АНО/150321/1-П-ОВ · распознано 26 листов',   warn:false },
  { time:'14:03:40', text:'файл КР-04.pdf · страница 12 низкого качества, помечена LOW_QUALITY', warn:true },
  { time:'14:03:55', text:'АНО/150321/1-РД-ОВ2.1 · распознано 15 листов', warn:false },
  { time:'14:04:11', text:'Сопоставление по матрице 1.1 · старт', warn:false }
];


export const detectionLabels: Record<string, string> = {
  logical:   'Логический анализ',
  semantic:  'Семантический диссонанс',
  normative: 'Нормативный анализ',
  ml:        'ML-паттерн'
};